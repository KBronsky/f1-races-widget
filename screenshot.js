// screenshot.js — обновлённый и устойчивый вариант
import puppeteer from "puppeteer";
import * as cheerio from "cheerio";
import { setTimeout } from "node:timers/promises";

const URL = "https://www.formula1.com/en/racing/2025.html";

/* ------------------------------------------------------------------
   🔥 Универсальный убийца cookie-баннеров, overlays, CMP, OneTrust
-------------------------------------------------------------------*/
async function nukeCookieBanners(page) {
  console.log("Nuking cookie banners & overlays…");

  await page.evaluate(() => {
    function removeCandidates() {
      const KW = ["cookie", "consent", "privacy", "manage", "agree"];

      // 1) Удаляем всё с ключевыми словами в тексте
      document.querySelectorAll("body *").forEach(el => {
        try {
          const text = (el.innerText || "").toLowerCase();
          if (KW.some(k => text.includes(k))) el.remove();
        } catch {}
      });

      // 2) Удаляем известные селекторы
      const selectors = [
        '[id*="cookie"]',
        '[class*="cookie"]',
        '[id*="consent"]',
        '[class*="consent"]',
        '[id*="banner"]',
        '[class*="banner"]',
        '[id*="overlay"]',
        '[class*="overlay"]',
        '[id*="onetrust"]',
        '[class*="onetrust"]',
        '[id*="ot-"]',
        '[class*="ot-"]'
      ];
      document.querySelectorAll(selectors.join(",")).forEach(el => el.remove());

      // 3) Удаляем FIXED элементы с высоким z-index
      document.querySelectorAll("body *").forEach(el => {
        const s = window.getComputedStyle(el);
        const zi = parseInt(s.zIndex);
        if (
          (s.position === "fixed" || s.position === "sticky") &&
          zi > 999 &&
          el.offsetHeight > 50
        ) {
          el.remove();
        }
      });

      // 4) Удаляем всё, что перекрывает > 40% высоты
      const viewportH = window.innerHeight;
      document.querySelectorAll("body *").forEach(el => {
        try {
          const rect = el.getBoundingClientRect();
          if (rect.height > viewportH * 0.4) el.remove();
        } catch {}
      });
    }

    // CMP подгружается дольше → несколько проходов
    removeCandidates();
    setTimeout(removeCandidates, 500);
    setTimeout(removeCandidates, 1500);
    setTimeout(removeCandidates, 3000);
  });

  await setTimeout(2000);
}

// Парсит текст вроде "28 - 30 Nov" -> { start: Date, end: Date }
function parseRaceDate(dateText) {
  if (!dateText) return null;
  // Убираем лишние пробелы
  const tokens = dateText.trim().split(/\s+/);
  // Возможные варианты: ["28","-","30","Nov"] или ["30","Nov","-","2","Dec"]
  // Попробуем найти два числа и месяц справа (или два числа и месяц в конце)
  const nums = tokens.filter(t => /^\d+$/.test(t)).map(Number);
  const months = tokens.filter(t => /^[A-Za-z]{3,}$/.test(t));
  if (nums.length === 0 || months.length === 0) return null;

  // берем последний месяц-строку (например "Nov" или "December")
  const monthStr = months[months.length - 1].slice(0, 3);
  const monthMap = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
  const month = monthMap[monthStr] ?? 0;

  // если есть два числа — первый = start, второй = end; если одно — оба равны ему
  const startDay = nums[0];
  const endDay = nums[1] ?? nums[0];

  const year = 2025; // сезон 2025
  const start = new Date(year, month, startDay);
  const end = new Date(year, month, endDay);
  return { start, end };
}

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

  // Anti-headless tweaks
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36");
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  // Навигация и ожидания
  console.log("Go to page:", URL);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 0 });

  // Ждём, пока карточки появятся (React может рендерить позже)
  try {
    await page.waitForSelector("a.group", { timeout: 30000 });
  } catch (e) {
    console.error("a.group not found after wait:", e.message);
  }

  // Дадим дополнительное время для загрузки стилей и шрифтов
  await setTimeout(1500);
  // Убедимся, что network почти закончил: небольшой доп.ожидание
  await setTimeout(800);

  // Получаем HTML и парсим через cheerio (статический снимок DOM в этот момент)
  const html = await page.content();
  const $ = cheerio.load(html);

  const cards = [];
  // Перебираем реальные карточки как в DOM — это тот же селектор, который ты присылал
  $("a.group").each((i, el) => {
    const $el = $(el);
    // Название — обычно <p class="typography-module_display-xl-bold__Gyl5W">Las Vegas</p>
    const title = $el.find("p.typography-module_display-xl-bold__Gyl5W").first().text().trim()
      || $el.find("p").first().text().trim();

    // Дата — два варианта: будущие (big) или прошедшие (xs)
    const dateFuture = $el.find("span.typography-module_technical-m-bold__JDsxP, span.typography-module_technical-m-bold__JDsxP.typography-module_lg_technical-l-bold__d8tzL").first().text().trim();
    const datePast = $el.find("span.typography-module_technical-xs-regular__-W0Gs").first().text().trim();

    const dateText = dateFuture || datePast || "";

    const parsed = parseRaceDate(dateText);

    // NEXT RACE метка (если есть)
    const isNextRace = $el.find("span.typography-module_body-2-xs-bold__M03Ei").filter((_, s) => $(s).text().trim() === "NEXT RACE").length > 0;

    cards.push({
      index: i,           // индекс в выборке page.$$()
      title,
      dateText,
      parsed,
      isNextRace
    });
  });

  console.log(`Found ${cards.length} cards`);

  if (cards.length === 0) {
    console.error("No race cards found in cheerio parsing — page structure changed or blocked.");
  } else {
    // Вывод первых нескольких для отладки
    cards.slice(0, 6).forEach((c, idx) => {
      console.log(`#${idx} title="${c.title}" date="${c.dateText}" next=${c.isNextRace}`);
    });
  }

  const now = new Date();

  // Определяем last (последняя прошедшая) и next (следующая)
  const past = cards.filter(c => c.parsed && c.parsed.end < now).sort((a,b)=>b.parsed.end - a.parsed.end);
  const future = cards.filter(c => c.parsed && c.parsed.start >= now).sort((a,b)=>a.parsed.start - b.parsed.start);

  let lastRace = past.length ? past[0] : null;
  let nextRace = cards.find(c => c.isNextRace) || (future.length ? future[0] : null);

  console.log("Determined nextRace:", nextRace ? `${nextRace.title} ${nextRace.dateText}` : "NONE");
  console.log("Determined lastRace:", lastRace ? `${lastRace.title} ${lastRace.dateText}` : "NONE");

  // Получаем реальные element handles из браузера (в актуальном DOM)
  const handles = await page.$$("a.group");
  console.log("Found element handles:", handles.length);

  async function screenshotByCard(card, filename) {
    if (!card) {
      console.log(`No card provided for ${filename}`);
      return;
    }
    const idx = card.index;
    const handle = handles[idx];
    if (!handle) {
      // На всякий случай пробуем поиск по содержимому title внутри браузера
      console.warn(`Handle for index ${idx} not found; trying fallback search by title.`);
      const fallback = await page.$x(`//a[contains(., "${card.title.replace(/"/g,'')}" )]`);
      if (fallback && fallback[0]) {
        await fallback[0].screenshot({ path: filename });
        console.log(`Saved (fallback) ${filename}`);
        return;
      } else {
        console.error("Fallback also failed — cannot find element handle.");
        return;
      }
    }

    // Скроллим к элементу и ждём стабильности
    try {
      await handle.evaluate(el => el.scrollIntoView({behavior: "auto", block: "center", inline: "center"}));
    } catch (e) { /* ignore */ }
    await setTimeout(800);

    // Делаем скриншот напрямую через elementHandle.screenshot()
    try {
      await handle.screenshot({ path: filename });
      console.log(`Saved ${filename}`);
    } catch (err) {
      console.error(`Screenshot error for ${filename}:`, err.message);
    }
  }

  // Делаем скриншоты
  await nukeCookieBanners(page);
  await screenshotByCard(nextRace, "f1_next_race.png");
  await screenshotByCard(lastRace, "f1_last_race.png");

  await browser.close();
  console.log("Done.");
}

run().catch(err => {
  console.error("Unhandled error:", err);
  process.exit(1);
});


