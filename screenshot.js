// screenshot.js — финальная версия (устойчивая, без page.$x, с robust date parsing)
import puppeteer from "puppeteer";
import * as cheerio from "cheerio";
import { setTimeout as delay } from "node:timers/promises";
import fs from "fs";


const URL = "https://www.formula1.com/en/racing/2025.html";

/* -------------------------
   Утилиты: парсер даты
   Поддерживает:
   "28 - 30 Nov"  и  "30 Nov - 2 Dec"
---------------------------- */
function parseRaceDate(dateText) {
  if (!dateText) return null;
  const txt = dateText.trim();

  // Попытка матча: day [Mon]? - day [Mon]?
  const regex = /(\d{1,2})(?:\s*([A-Za-z]{3,}))?\s*-\s*(\d{1,2})(?:\s*([A-Za-z]{3,}))?/;
  const m = txt.match(regex);
  const monthMap = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };

  if (m) {
    const d1 = parseInt(m[1], 10);
    const mon1 = m[2] ? m[2].slice(0,3) : null;
    const d2 = parseInt(m[3], 10);
    const mon2 = m[4] ? m[4].slice(0,3) : null;

    // Выбираем месяц: если оба есть — используем соответственно, иначе используем тот, который есть
    let monthIndex1 = mon1 ? monthMap[mon1] : null;
    let monthIndex2 = mon2 ? monthMap[mon2] : null;

    // Если нет ни одного месяца — пытаемся найти слово-месяц в строке
    if (monthIndex1 === null && monthIndex2 === null) {
      const found = txt.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i);
      if (found) {
        monthIndex1 = monthIndex2 = monthMap[found[0].slice(0,3)];
      } else {
        monthIndex1 = monthIndex2 = 10; // fallback Nov (shouldn't happen for 2025 page)
      }
    } else {
      if (monthIndex1 === null) monthIndex1 = monthIndex2;
      if (monthIndex2 === null) monthIndex2 = monthIndex1;
    }

    // Год: по умолчанию 2025 (сезон 2025)
    const year = 2025;

    const start = new Date(year, monthIndex1, d1);
    const end = new Date(year, monthIndex2, d2);

    // If end < start (e.g., 30 Dec - 2 Jan) — assume year rollover for end
    if (end < start) {
      end.setFullYear(end.getFullYear() + 1);
    }

    return { start, end };
  }

  // fallback: попробуем извлечь первое цифровое значение как start
  const nums = txt.match(/\d{1,2}/g);
  const months = txt.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i);
  if (nums && months) {
    const monthIndex = monthMap[months[0].slice(0,3)];
    const start = new Date(2025, monthIndex, parseInt(nums[0],10));
    const end = new Date(2025, monthIndex, parseInt(nums[1] ? nums[1] : nums[0],10));
    return { start, end };
  }

  return null;
}

/* -------------------------
   Агрессивная очистка баннеров
---------------------------- */
async function nukeCookieBanners(page) {
  // несколько проходов; оставляем небольшие таймауты
  await page.evaluate(() => {
    const KW = ["cookie","consent","privacy","agree","manage","gdpr","opt-in","optout","opt-out"];

    function removeByText() {
      document.querySelectorAll("body *").forEach(el => {
        try {
          const t = (el.innerText || "").toLowerCase();
          if (!t) return;
          for (const k of KW) {
            if (t.includes(k) && el.offsetHeight > 10) {
              el.remove();
              return;
            }
          }
        } catch (e) {}
      });
    }

    function removeBySelector() {
      const sel = [
        '[id*="cookie"]','[class*="cookie"]',
        '[id*="consent"]','[class*="consent"]',
        '[id*="onetrust"]','[class*="onetrust"]',
        '[id*="ot-"]','[class*="ot-"]',
        '[class*="ot-"]','[class*="banner"]','[id*="banner"]',
        '[class*="overlay"]','[id*="overlay"]'
      ];
      try {
        document.querySelectorAll(sel.join(",")).forEach(e=>e.remove());
      } catch {}
    }

    function removeFixedBig() {
      const viewportH = window.innerHeight;
      document.querySelectorAll("body *").forEach(el => {
        try {
          const s = window.getComputedStyle(el);
          const zi = parseInt(s.zIndex) || 0;
          if ((s.position === "fixed" || s.position === "sticky") && zi > 500 && el.offsetHeight > viewportH*0.15) {
            el.remove();
          }
        } catch {}
      });
    }

    removeByText();
    removeBySelector();
    removeFixedBig();

    setTimeout(removeByText, 300);
    setTimeout(removeBySelector, 600);
    setTimeout(removeFixedBig, 1000);
    setTimeout(removeByText, 2000);
  });

  // небольшой delay, чтобы DOM успел стабилизироваться
  await delay(900);
}

/* -------------------------
   Поиск карточек и скриншот
---------------------------- */
async function screenshotByCard(page, card, filename) {
  if (!card) {
    console.log(`No card for ${filename}`);
    return;
  }

  console.log(`Attempt screenshot for "${card.title}" (${card.dateText}) -> ${filename}`);

  // поиск в актуальном DOM: перебираем a.group и ищем совпадение по dateText (точнее) или title (fallback)
  const targetDate = card.dateText;
  const targetTitle = card.title;

  // повторим 3 раза, т.к. возможно ре-рендер
  for (let attempt = 1; attempt <= 3; attempt++) {
    // удалим баннеры прямо перед поиском
    await nukeCookieBanners(page);

    // заберём все элементы a.group
    const handles = await page.$$("a.group");

    console.log(`Found ${handles.length} DOM nodes (attempt ${attempt})`);

    let foundHandle = null;

    // проверяем каждый handle по содержимому (в evaluate, чтобы не приводить к detached handles)
    for (let i = 0; i < handles.length; i++) {
      try {
        const matches = await handles[i].evaluate((el, targetDate, targetTitle) => {
          // ищем дата-строки и title внутри элемента
          const text = (el.innerText || "").replace(/\s+/g," ").trim();
          const hasDate = targetDate ? text.includes(targetDate) : false;
          const hasTitle = targetTitle ? text.includes(targetTitle) : false;
          return { hasDate, hasTitle };
        }, targetDate, targetTitle);

        if (matches.hasDate || matches.hasTitle) {
          foundHandle = handles[i];
          console.log(`Matched node index ${i} (hasDate=${matches.hasDate}, hasTitle=${matches.hasTitle})`);
          break;
        }
      } catch (e) {
        // может быть detached — игнорируем и продолжаем
        continue;
      }
    }

    if (!foundHandle) {
      console.log(`No matching DOM node on attempt ${attempt} (will retry)`);
      // небольшая пауза
      await delay(700 * attempt);
      continue;
    }

    // Подготовка к скриншоту: скролл и короткая стабилизация
    try {
      await foundHandle.evaluate(el => el.scrollIntoView({ behavior: "auto", block: "center" }));
    } catch {}
    await delay(500);

    // последний nuke перед скрином
    await nukeCookieBanners(page);
    await delay(300);

    // Делаем скриншот элемента
    try {
      await foundHandle.screenshot({ path: filename });
      console.log(`Saved ${filename}`);
      return;
    } catch (err) {
      console.warn(`Screenshot attempt ${attempt} failed: ${err.message}`);
      await delay(500 * attempt);
      continue;
    }
  }

  console.error(`Failed to screenshot ${filename} after retries.`);
}

/* -------------------------
   Основной run()
---------------------------- */
async function run() {
  console.log("Start screenshot.js");

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--disable-gpu"
    ],
    defaultViewport: { width: 1920, height: 1080 }
  });

  const page = await browser.newPage();

  // anti-headless
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36");
  await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, "webdriver", { get: () => false }); });

  console.log("Navigating to", URL);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 0 });

  // ждём появления карточек
  try {
    await page.waitForSelector("a.group", { timeout: 30000 });
  } catch (e) {
    console.warn("a.group not found in time:", e.message);
  }

  // короткая задержка для рендера
  await delay(1200);
  // и убиваем баннеры
  await nukeCookieBanners(page);
  await delay(600);

  // Берём snapshot HTML и парсим cheerio
  const html = await page.content();
  fs.writeFileSync("debug.html", html);
  console.log("Saved debug.html");
  const $ = cheerio.load(html);

  const cards = [];
  $("a.group").each((i, el) => {
    const $el = $(el);
    const title = $el.find("p.typography-module_display-xl-bold__Gyl5W").first().text().trim() || $el.find("p").first().text().trim();
    const dateFuture = $el.find("span.typography-module_technical-m-bold__JDsxP, span.typography-module_lg_technical-l-bold__d8tzL").first().text().trim();
    const datePast = $el.find("span.typography-module_technical-xs-regular__-W0Gs").first().text().trim();
    const dateText = dateFuture || datePast || "";
    const parsed = parseRaceDate(dateText);
    cards.push({ index: i, title, dateText, parsed });
  });

  console.log("Parsed", cards.length, "cards");
  cards.slice(0,6).forEach((c, idx) => console.log(`#${idx}: "${c.title}" -> ${c.dateText}, parsed: ${c.parsed ? c.parsed.start.toISOString().slice(0,10) + " / " + c.parsed.end.toISOString().slice(0,10) : "null"}`));

  // Логика выбора next / last:
  const today = new Date();
  // normalize to local date (strip time)
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  const past = cards.filter(c => c.parsed && c.parsed.end < t0).sort((a,b)=>b.parsed.end - a.parsed.end);
  // next: first card with parsed.end >= t0 (i.e. today <= end) — includes ongoing and upcoming
  const nextCandidates = cards.filter(c => c.parsed && c.parsed.end >= t0).sort((a,b)=>a.parsed.start - b.parsed.start);

  const lastRace = past.length ? past[0] : null;
  const nextRace = nextCandidates.length ? nextCandidates[0] : null;

  console.log("Determined nextRace:", nextRace ? `${nextRace.title} (${nextRace.dateText})` : "NONE");
  console.log("Determined lastRace:", lastRace ? `${lastRace.title} (${lastRace.dateText})` : "NONE");

  // Скриншоты (поиск live в DOM + retries)
  if (nextRace) {
    await screenshotByCard(page, nextRace, "f1_next_race.png");
  } else {
    console.log("No next race to screenshot.");
  }

  if (lastRace) {
    await screenshotByCard(page, lastRace, "f1_last_race.png");
  } else {
    console.log("No last race to screenshot.");
  }

  await browser.close();
  console.log("Finished.");
}

/* -------------------------
   Запуск
---------------------------- */
run().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
