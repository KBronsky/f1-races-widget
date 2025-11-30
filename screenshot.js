// screenshot.js — финальная стабильная версия
import puppeteer from "puppeteer";
import * as cheerio from "cheerio";
import fs from "fs";
import { setTimeout } from "node:timers/promises";
import sharp from "sharp";

// ----------------------------------------------
// Настройки
// ----------------------------------------------
const URL = "https://www.formula1.com/en/racing/2025.html";

// ----------------------------------------------
// 1. Разбор даты "28 - 30 Nov" → start/end (UTC)
// ----------------------------------------------
function parseRaceDate(dateText) {
  if (!dateText) return null;

  const tokens = dateText.trim().split(/\s+/);
  const nums = tokens.filter(t => /^\d+$/.test(t)).map(Number);
  const months = tokens.filter(t => /^[A-Za-z]+$/.test(t));

  if (nums.length === 0 || months.length === 0) return null;

  const monthShort = months[months.length - 1].slice(0, 3);
  const monthMap = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
  const month = monthMap[monthShort] ?? 0;

  const startDay = nums[0];
  const endDay = nums[1] ?? nums[0];

  const year = 2025;

  return {
    start: new Date(Date.UTC(year, month, startDay)),
    end:   new Date(Date.UTC(year, month, endDay))
  };
}

// ----------------------------------------------
// 2. Правильная установка темы (sessionStorage)
//    Работает: заходим на домен, пишем в storage,
//    затем — на страницу гонок.
// ----------------------------------------------
async function setThemeBeforeLoad(page, theme) {
  console.log(`Setting theme: ${theme}`);

  // Заходим на корень домена
  await page.goto("https://www.formula1.com", {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  // Устанавливаем sessionStorage['dark-mode']
  await page.evaluate((t) => {
    try {
      sessionStorage.setItem("dark-mode", t);
    } catch (e) {}
  }, theme);

  // Подстраховка: эмуляция prefers-color-scheme
  try {
    await page.emulateMediaFeatures([
      { name: "prefers-color-scheme", value: theme === "dark" ? "dark" : "light" }
    ]);
  } catch (e) {}

  // Переходим на страницу с гонками
  await setTimeout(250);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
}

// ----------------------------------------------
// 3. Удаление Cookie-баннера
// ----------------------------------------------
async function removeCookieBanner(page) {
  await setTimeout(1500);

  const frames = page.frames();
  for (const frame of frames) {
    try {
      const btn = await frame.$("button[title='Accept all']");
      if (btn) {
        console.log("Consent button found — clicking...");
        await btn.click();
        await setTimeout(1500);
        return;
      }
    } catch {}
  }

  console.log("Removing spam containers...");
  await page.evaluate(() => {
    document.querySelectorAll("[id^='sp_message_container_']").forEach(el => el.remove());
  });

  await setTimeout(800);
}

// ----------------------------------------------
// 4. Поиск карточек через Cheerio
// ----------------------------------------------
function extractRaceCards($) {
  const cards = [];

  $("a.group").each((i, el) => {
    const $el = $(el);

    const title =
      $el.find("p.typography-module_display-xl-bold__Gyl5W").first().text().trim() ||
      $el.find("p").first().text().trim();

    const dateBig = $el
      .find("span.typography-module_technical-m-bold__JDsxP")
      .first()
      .text()
      .trim();

    const dateSmall = $el
      .find("span.typography-module_technical-xs-regular__-W0Gs")
      .first()
      .text()
      .trim();

    const dateText = dateBig || dateSmall || "";
    const parsed = parseRaceDate(dateText);

    if (title && parsed) {
      cards.push({ index: i, title, dateText, parsed });
    }
  });

  return cards;
}

// ----------------------------------------------
// 5. Выбор lastRace / nextRace
// ----------------------------------------------
function pickRaces(cards) {
  // Сегодня по UTC (обнулим время)
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const past = cards.filter(c => c.parsed.end < today);
  const future = cards.filter(c => c.parsed.end >= today);

  const lastRace  = past.length   ? past.sort((a,b)=>b.parsed.end - a.parsed.end)[0] : null;
  const nextRace  = future.length ? future.sort((a,b)=>a.parsed.start - b.parsed.start)[0] : null;

  return { lastRace, nextRace };
}

// ----------------------------------------------
// 6. Скриншот карточки
// ----------------------------------------------
async function screenshotCard(page, card, filename) {
  if (!card) return;

  const els = await page.$$("a.group");
  const handle = els[card.index];
  if (!handle) {
    console.log(`Cannot find card ${card.title}, index ${card.index}`);
    return;
  }

  await handle.evaluate(el => el.scrollIntoView({behavior:"auto", block:"center"}));
  await setTimeout(600);

  await handle.screenshot({ path: filename });
  console.log(`Saved: ${filename}`);
}

// ----------------------------------------------
// 7. Композиция через sharp
// ----------------------------------------------
async function combineHorizontal(leftFile, rightFile, outFile) {
  if (!fs.existsSync(leftFile) || !fs.existsSync(rightFile)) return;

  const imgLeft = sharp(leftFile);
  const imgRight = sharp(rightFile);

  const leftMeta = await imgLeft.metadata();
  const rightMeta = await imgRight.metadata();
  const height = Math.max(leftMeta.height, rightMeta.height);
  const width = leftMeta.width + rightMeta.width;

  const bufferL = await imgLeft.png().toBuffer();
  const bufferR = await imgRight.png().toBuffer();

  await sharp({
    create: { width, height, channels: 4, background: { r:0, g:0, b:0, alpha:0 } }
  })
    .composite([
      { input: bufferL, top: 0, left: 0 },
      { input: bufferR, top: 0, left: leftMeta.width }
    ])
    .png()
    .toFile(outFile);

  console.log(`Composite saved: ${outFile}`);
}

// ----------------------------------------------
// 8. Создать папки + разложить файлы
// ----------------------------------------------
function organizeOutput() {
  const dirs = ["light_theme", "dark_theme", "composite", "debug"];
  dirs.forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive:true }); });

  const move = (src, dir, rename=null) => {
    if (!fs.existsSync(src)) return;
    fs.renameSync(src, rename ? `${dir}/${rename}` : `${dir}/${src}`);
  };

  move("f1_last_race_wt.png",  "light_theme");
  move("f1_next_race_wt.png",  "light_theme");
  move("f1_last_race_bk.png",  "dark_theme");
  move("f1_next_race_bk.png",  "dark_theme");

  move("f1_racewidget_wt.png", "composite");
  move("f1_racewidget_bk.png", "composite");

  move("debug_wt.png",  "debug");
  move("debug_wt.html", "debug");
  move("debug_bk.png",  "debug");
  move("debug_bk.html", "debug");
}

// ----------------------------------------------
// 9. Основная функция
// ----------------------------------------------
async function processTheme(theme, prefix) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    defaultViewport: { width: 1920, height: 1080 }
  });

  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");

  // Установка темы
  await setThemeBeforeLoad(page, theme);

  // Cookie-баннер
  await removeCookieBanner(page);

  // Снимок HTML
  const html = await page.content();
  fs.writeFileSync(`debug_${prefix}.html`, html);

  // Debug screenshot
  await page.screenshot({ path: `debug_${prefix}.png`, fullPage: true });

  // Парсим карточки
  const $ = cheerio.load(html);
  const cards = extractRaceCards($);
  console.log(`Parsed cards: ${cards.length}`);

  const { lastRace, nextRace } = pickRaces(cards);
  console.log("Last:", lastRace?.title, lastRace?.dateText);
  console.log("Next:", nextRace?.title, nextRace?.dateText);

  // Скриншоты
  await screenshotCard(page, lastRace, `f1_last_race_${prefix}.png`);
  await screenshotCard(page, nextRace, `f1_next_race_${prefix}.png`);

  await browser.close();
}

// ----------------------------------------------
// 10. Запуск двух тем + композиции + сортировки
// ----------------------------------------------
(async () => {
  console.log("=== Processing LIGHT THEME ===");
  await processTheme("light", "wt");

  console.log("=== Processing DARK THEME ===");
  await processTheme("dark", "bk");

  // Композиты
  await combineHorizontal("f1_last_race_wt.png", "f1_next_race_wt.png", "f1_racewidget_wt.png");
  await combineHorizontal("f1_last_race_bk.png", "f1_next_race_bk.png", "f1_racewidget_bk.png");

  // Разложить по папкам
  organizeOutput();

  console.log("=== DONE ===");
})();
