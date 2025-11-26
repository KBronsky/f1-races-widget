// screenshot.js — версия с обработкой cookie-banners и повышенной стабильностью
import puppeteer from "puppeteer";
import * as cheerio from "cheerio";
import { setTimeout } from "node:timers/promises";

const URL = "https://www.formula1.com/en/racing/2025.html";

// ----------------------
//   DATE PARSER
// ----------------------
function parseRaceDate(dateText) {
  if (!dateText) return null;

  const tokens = dateText.trim().split(/\s+/);
  const nums = tokens.filter(t => /^\d+$/.test(t)).map(Number);
  const months = tokens.filter(t => /^[A-Za-z]{3,}$/.test(t));

  if (nums.length === 0 || months.length === 0) return null;

  const monthStr = months[months.length - 1].slice(0, 3);
  const monthMap = {Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11};
  const month = monthMap[monthStr] ?? 0;

  const start = new Date(2025, month, nums[0]);
  const end = new Date(2025, month, nums[1] ?? nums[0]);

  return { start, end };
}

// ----------------------
//   COOKIE BANNER KILLER
// ----------------------
async function nukeCookieBanners(page) {
  console.log("Nuking cookie banners…");

  await page.evaluate(() => {
    function removeCandidates() {
      const keywords = ["cookie", "consent", "privacy", "agree", "manage"];
      
      // 1. Удаляем всё, что содержит ключевые слова в тексте
      document.querySelectorAll("body *").forEach(el => {
        try {
          const text = (el.innerText || "").toLowerCase();
          if (keywords.some(k => text.includes(k))) {
            el.remove();
          }
        } catch {}
      });

      // 2. Удаляем по ID/классам
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

      // 3. Удаляем фиксированные элементы, перекрывающие экран
      document.querySelectorAll("body *").forEach(el => {
        const style = window.getComputedStyle(el);
        if (
          (style.position === "fixed" || style.position === "sticky") &&
          parseInt(style.zIndex) > 9990
        ) {
          el.remove();
        }
      });
    }

    // Запускаем очистку несколько раз (баннеры появляются динамически)
    removeCandidates();
    setTimeout(removeCandidates, 500);
    setTimeout(removeCandidates, 1000);
    setTimeout(removeCandidates, 2000);
  });

//   await new Promise(resolve => setTimeout(resolve, 2000));
}

// ----------------------
//   MAIN LOGIC
// ----------------------
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

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36"
  );

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  console.log("Navigating:", URL);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 0 });

  // Wait extra to ensure React content rendered
  await setTimeout(1500);

  // -------------- HANDLE COOKIE BANNER --------------
  await nukeCookieBanners(page);
  await setTimeout(800);

  // Wait until race cards appear
  await page.waitForSelector("a.group", { timeout: 30000 });
  await setTimeout(800);

  // Parse HTML snapshot
  const html = await page.content();
  const $ = cheerio.load(html);

  const cards = [];
  $("a.group").each((i, el) => {
    const $el = $(el);

    const title =
      $el.find("p.typography-module_display-xl-bold__Gyl5W").first().text().trim() ||
      $el.find("p").first().text().trim();

    const dateFuture = $el
      .find(
        "span.typography-module_technical-m-bold__JDsxP, span.typography-module_lg_technical-l-bold__d8tzL"
      )
      .first()
      .text()
      .trim();

    const datePast = $el
      .find("span.typography-module_technical-xs-regular__-W0Gs")
      .first()
      .text()
      .trim();

    const dateText = dateFuture || datePast || "";

    const isNextRace =
      $el.find("span.typography-module_body-2-xs-bold__M03Ei")
        .filter((_, s) => $(s).text().trim() === "NEXT RACE")
        .length > 0;

    cards.push({
      index: i,
      title,
      dateText,
      parsed: parseRaceDate(dateText),
      isNextRace
    });
  });

  console.log(`Found ${cards.length} cards`);

  const now = new Date();
  const past = cards
    .filter(c => c.parsed && c.parsed.end < now)
    .sort((a, b) => b.parsed.end - a.parsed.end);

  const future = cards
    .filter(c => c.parsed && c.parsed.start >= now)
    .sort((a, b) => a.parsed.start - b.parsed.start);

  const lastRace = past[0] || null;
  const nextRace = cards.find(c => c.isNextRace) || future[0] || null;

  console.log("Last race:", lastRace?.title || "none");
  console.log("Next race:", nextRace?.title || "none");

  const handles = await page.$$("a.group");

  async function screenshotCard(card, filename) {
    if (!card) {
      console.log(`Cannot screenshot ${filename}: card is null`);
      return;
    }

    const handle = handles[card.index];

    if (handle) {
      await handle.evaluate(el =>
        el.scrollIntoView({ behavior: "auto", block: "center" })
      );
      await setTimeout(500);

      await handle.screenshot({ path: filename });
      console.log(`Saved screenshot: ${filename}`);
      return;
    }

    console.log(`Handle not found for index ${card.index}, trying fallback search…`);

    const fallback = await page.$x(
      `//a[contains(., "${card.title.replace(/"/g, "")}")]`
    );

    if (fallback.length > 0) {
      await fallback[0].screenshot({ path: filename });
      console.log(`Saved fallback screenshot: ${filename}`);
    } else {
      console.log(`Fallback failed — screenshot for ${filename} not created.`);
    }
  }

  await nukeCookieBanners(page);
  await screenshotCard(nextRace, "f1_next_race.png");
  await nukeCookieBanners(page);
  await screenshotCard(lastRace, "f1_last_race.png");

  await browser.close();
  console.log("Done.");
}

run().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});



