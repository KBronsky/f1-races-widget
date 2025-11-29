// screenshot.js — стабильный вариант для GitHub Actions + Puppeteer
import puppeteer from "puppeteer";
import * as cheerio from "cheerio";
import fs from "fs";
import { setTimeout } from "node:timers/promises";

const URL = "https://www.formula1.com/en/racing/2025.html";

/* ----------------------------------------------------------
   Парсинг даты формата: "28 - 30 Nov"
---------------------------------------------------------- */
function parseRaceDate(text) {
  if (!text) return null;
  const tokens = text.trim().split(/\s+/);

  const nums = tokens.filter(t => /^\d+$/.test(t)).map(Number);
  const months = tokens.filter(t => /^[A-Za-z]{3,}$/.test(t));

  if (nums.length === 0 || months.length === 0) return null;

  const monthStr = months[months.length - 1].slice(0, 3);
  const monthMap = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
  };
  const month = monthMap[monthStr] ?? 0;

  const startDay = nums[0];
  const endDay = nums[1] ?? nums[0];

  const year = 2025;

  return {
    start: new Date(year, month, startDay),
    end: new Date(year, month, endDay)
  };
}

/* ----------------------------------------------------------
   Точное удаление cookie-баннера SourcePoint
---------------------------------------------------------- */
async function removeCookieBanner(page) {
  console.log("Trying to remove cookie banner…");

  try {
    await page.evaluate(() => {
      const div = [...document.querySelectorAll("div[id^='sp_message_container_']")];
      div.forEach(el => el.remove());
    });
  } catch (e) {
    console.log("Cookie banner removal failed:", e.message);
  }

  await setTimeout(500);
}

/* ----------------------------------------------------------
   Основная логика
---------------------------------------------------------- */
async function run() {
  console.log("Launching browser…");

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage"
    ],
    defaultViewport: { width: 1920, height: 1080 }
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36"
  );

  console.log("Opening:", URL);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });

  // Дожидаемся появления карточек (React SPA)
  let cardsFound = false;
  for (let i = 0; i < 10; i++) {
    const html = await page.content();
    const $ = cheerio.load(html);
    const cards = $("a.group").length;

    if (cards > 0) {
      cardsFound = true;
      break;
    }

    await setTimeout(1000);
  }

  if (!cardsFound) {
    console.error("ERROR: race cards did not load.");
    await browser.close();
    process.exit(1);
  }

  // Удаляем баннер
  await removeCookieBanner(page);

  // Даем странице перестроиться
  await setTimeout(800);

  // Снова забираем HTML после удаления баннера
  const html = await page.content();
  const $ = cheerio.load(html);

  const cards = [];
  $("a.group").each((index, el) => {
    const $el = $(el);

    const title =
      $el.find("p.typography-module_display-xl-bold__Gyl5W").first().text().trim() ||
      $el.find("p").first().text().trim();

    const dateText =
      $el
        .find(
          "span.typography-module_technical-m-bold__JDsxP, span.typography-module_technical-m-bold__JDsxP.typography-module_lg_technical-l-bold__d8tzL"
        )
        .first()
        .text()
        .trim() ||
      $el.find("span.typography-module_technical-xs-regular__-W0Gs").first().text().trim();

    const parsed = parseRaceDate(dateText);

    if (parsed) {
      cards.push({
        index,
        title,
        dateText,
        parsed
      });
    }
  });

  console.log(`Parsed ${cards.length} race cards.`);

  // ------------------------
  // Логика выбора гонок
  // ------------------------
  const now = new Date();

  const future = cards.filter(c => now <= c.parsed.end).sort((a, b) => a.parsed.start - b.parsed.start);
  const past = cards.filter(c => now > c.parsed.end).sort((a, b) => b.parsed.end - a.parsed.end);

  const nextRace = future[0] || null;
  const lastRace = past[0] || null;

  console.log("Next race:", nextRace ? `${nextRace.title} (${nextRace.dateText})` : "NONE");
  console.log("Last race:", lastRace ? `${lastRace.title} (${lastRace.dateText})` : "NONE");

  const handles = await page.$$("a.group");

  async function screenshotCard(card, output) {
    if (!card) {
      console.log(`No card for ${output}`);
      return;
    }

    const handle = handles[card.index];
    if (!handle) {
      console.log(`Handle not found for ${card.title}`);
      return;
    }

    try {
      await handle.evaluate(el =>
        el.scrollIntoView({ behavior: "auto", block: "center", inline: "center" })
      );
      await setTimeout(600);

      await handle.screenshot({ path: output });
      console.log("Saved:", output);
    } catch (err) {
      console.log("Screenshot error:", err);
    }
  }

  await screenshotCard(nextRace, "f1_next_race.png");
  await screenshotCard(lastRace, "f1_last_race.png");

  await browser.close();
  console.log("Done.");
}

run().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
