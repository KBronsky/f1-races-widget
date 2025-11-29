// screenshot.js — стабильная версия для GitHub Actions
import puppeteer from "puppeteer";
import fs from "fs";
import * as cheerio from "cheerio";
import sharp from "sharp";
import { setTimeout } from "node:timers/promises";

const URL_RACES = "https://www.formula1.com/en/racing/2025.html";
const URL_ROOT  = "https://www.formula1.com";

/* ----------------------------------------------
    Вспомогательное: дата -> {start, end}
------------------------------------------------*/
function parseRaceDate(dateText) {
  if (!dateText) return null;

  const parts = dateText.trim().split(/\s+/);
  const nums = parts.filter(t => /^\d+$/.test(t)).map(Number);
  const months = parts.filter(t => /^[A-Za-z]{3,}$/.test(t));

  if (!nums.length || !months.length) return null;

  const monthStr = months[months.length - 1].slice(0, 3);
  const monthMap = {
    Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5,
    Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11
  };

  const month = monthMap[monthStr] ?? 0;
  const start = nums[0];
  const end = nums[1] ?? nums[0];

  const year = 2025;
  return {
    start: new Date(Date.UTC(year, month, start)),
    end:   new Date(Date.UTC(year, month, end))
  };
}

/* ----------------------------------------------
   Выбор следующей и последней гонки
------------------------------------------------*/
function pickRaces(cards) {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const nextCandidates = cards.filter(c => today <= c.parsed.end);
  const prevCandidates = cards.filter(c => today > c.parsed.end);

  nextCandidates.sort((a,b) => a.parsed.start - b.parsed.start);
  prevCandidates.sort((a,b) => b.parsed.end - a.parsed.end);

  return {
    next: nextCandidates[0] || null,
    last: prevCandidates[0] || null
  };
}

/* ----------------------------------------------
   Cookie Banner Killer
------------------------------------------------*/
async function handleCookieBanner(page) {
  try {
    await page.waitForSelector("iframe[id^='sp_message_iframe_']", { timeout: 8000 });
  } catch {
    return; // нет баннера
  }

  const frames = page.frames();
  const frame = frames.find(f => f.url().includes("consent.formula1.com"));
  if (frame) {
    try {
      const btn = await frame.waitForSelector("button[title='Accept all']", { timeout: 4000 });
      await btn.click();
      await setTimeout(1500);
      return;
    } catch {}
  }

  // fallback: удаляем весь контейнер
  await page.evaluate(() => {
    document.querySelectorAll("div[id^='sp_message_container_']").forEach(el => el.remove());
  });

  await setTimeout(1500);
}

/* ----------------------------------------------
   Обработка одной темы (light / dark)
------------------------------------------------*/
async function processTheme(page, theme, outPrefix) {
  console.log(`\n===== PROCESS THEME: ${theme} =====`);

  // 1) Заходим на корень, чтобы был доступ к localStorage
  await page.goto(URL_ROOT, { waitUntil: "domcontentloaded" });

  // 2) Ставим тему
  await page.evaluate(t => {
    localStorage.setItem("dark-mode", t);
  }, theme);

  await setTimeout(300);

  // 3) Переходим на страницу гонок
  await page.goto(URL_RACES, { waitUntil: "domcontentloaded", timeout: 0 });

  // 4) Убираем cookie всплывашку
  await handleCookieBanner(page);

  // 5) Делаем debug-файлы
  const debugHTML = `debug_${outPrefix}.html`;
  const debugPNG  = `debug_${outPrefix}.png`;

  fs.writeFileSync(debugHTML, await page.content());
  await page.screenshot({ path: debugPNG, fullPage: true });

  console.log(`Debug saved: ${debugHTML}, ${debugPNG}`);

  // 6) Парсим карточки
  const html = await page.content();
  const $ = cheerio.load(html);
  const cards = [];

  $("a.group").each((i, el) => {
    const $el = $(el);

    const title =
      $el.find("p.typography-module_display-xl-bold__Gyl5W").first().text().trim() ||
      $el.find("p").first().text().trim();

    const dateFuture =
      $el.find("span.typography-module_technical-m-bold__JDsxP").first().text().trim();
    const datePast =
      $el.find("span.typography-module_technical-xs-regular__-W0Gs").first().text().trim();

    const dateText = dateFuture || datePast || "";
    const parsed = parseRaceDate(dateText);

    if (!parsed) return;

    cards.push({ index: i, title, dateText, parsed });
  });

  console.log(`Parsed cards: ${cards.length}`);
  cards.slice(0, 5).forEach(c => console.log(` - ${c.title} : ${c.dateText}`));

  if (!cards.length) return null;

  const races = pickRaces(cards);
  console.log("Next:", races.next?.title, races.next?.dateText);
  console.log("Last:", races.last?.title, races.last?.dateText);

  // 7) Скриншоты
  const handles = await page.$$("a.group");

  async function doShot(card, filename) {
    if (!card) return;

    const h = handles[card.index];
    if (!h) return;

    await h.evaluate(el => el.scrollIntoView({block:"center"}));
    await setTimeout(700);
    await h.screenshot({ path: filename });
    console.log("Shot:", filename);
  }

  await doShot(races.next, `f1_next_race_${outPrefix}.png`);
  await doShot(races.last, `f1_last_race_${outPrefix}.png`);

  return races;
}

/* ----------------------------------------------
   Композиция с помощью sharp
------------------------------------------------*/
async function compose(prefix) {
  const left  = `f1_last_race_${prefix}.png`;
  const right = `f1_next_race_${prefix}.png`;

  if (!fs.existsSync(left) || !fs.existsSync(right)) {
    console.log(`Skipping composition for ${prefix}: files missing`);
    return;
  }

  const imgLeft  = sharp(left);
  const imgRight = sharp(right);

  const metaL = await imgLeft.metadata();
  const metaR = await imgRight.metadata();

  const gap = 0;
  const totalW = metaL.width + metaR.width + gap;
  const totalH = Math.max(metaL.height, metaR.height);

  const out = `f1_racewidget_${prefix}.png`;

  await sharp({
    create: { width: totalW, height: totalH, channels: 3, background: "#000" }
  })
    .composite([
      { input: left, left: 0, top: 0 },
      { input: right, left: metaL.width + gap, top: 0 }
    ])
    .png()
    .toFile(out);

  console.log("Composed:", out);
}

/* ----------------------------------------------
                  MAIN
------------------------------------------------*/
(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    defaultViewport: { width: 1920, height: 1080 }
  });

  const page = await browser.newPage();

  // Светлая тема
  await processTheme(page, "light", "wt");

  // Тёмная тема
  await processTheme(page, "dark", "bk");

  // Композиции
  await compose("wt");
  await compose("bk");

  await browser.close();
})();
