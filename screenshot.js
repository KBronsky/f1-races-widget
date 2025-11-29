// screenshot.js — версия с кликом по кнопке "Accept all" внутри iframe (consent.formula1.com)
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
  const monthMap = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
  const month = monthMap[monthStr] ?? 0;
  const startDay = nums[0];
  const endDay = nums[1] ?? nums[0];
  const year = 2025;
  return { start: new Date(year, month, startDay), end: new Date(year, month, endDay) };
}

async function clickAcceptInConsentFrame(page) {
  // ищем фрейм consent (consent.formula1.com)
  const frames = page.frames();
  let consentFrame = frames.find(f => {
    try {
      return f.url().includes("consent.formula1.com");
    } catch (e) {
      return false;
    }
  });

  if (!consentFrame) {
    // Возможно iframe ещё не добавлен — попробуем найти по id элемента-iframe в DOM
    const iframeHandle = await page.$("iframe[id^='sp_message_iframe_']");
    if (iframeHandle) {
      try {
        consentFrame = await iframeHandle.contentFrame();
      } catch (e) {
        consentFrame = null;
      }
    }
  }

  if (!consentFrame) {
    console.log("Consent iframe not found.");
    return false;
  }

  console.log("Consent iframe found, URL:", consentFrame.url());

  // Попытки нажать кнопку по разным селекторам / вариантах текста
  const selectors = [
    'button[aria-label="Accept all"]',
    'button[title="Accept all"]',
    'button:has-text("Accept all")' // puppeteer указывает не поддерживает :has-text — но оставим для попытки
  ];

  // Также будем использовать XPath внутри фрейма как fallback (по тексту)
  try {
    for (const sel of selectors) {
      try {
        const btn = await consentFrame.waitForSelector(sel, { timeout: 3000 });
        if (btn) {
          await btn.click();
          console.log("Clicked accept button via selector:", sel);
          return true;
        }
      } catch (e) {
        // селектор не найден — пробуем дальше
      }
    }

    // XPath fallback: ищем кнопку по тексту "Accept all" (чувствительность к регистру учтём)
    const xpathCandidates = [
      "//button[contains(normalize-space(.), 'Accept all')]",
      "//button[contains(., 'Accept all')]",
      "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'), 'accept all')]"
    ];

    for (const xp of xpathCandidates) {
      try {
        const handles = await consentFrame.$x(xp);
        if (handles && handles.length) {
          await handles[0].click();
          console.log("Clicked accept button via XPath:", xp);
          return true;
        }
      } catch (e) {
        // ignore
      }
    }
  } catch (err) {
    console.log("Error while clicking inside consent frame:", err.message);
  }

  console.log("Accept button not found inside consent iframe.");
  return false;
}

async function removeSpMessageContainers(page) {
  try {
    await page.evaluate(() => {
      document.querySelectorAll("div[id^='sp_message_container_']").forEach(el => el.remove());
    });
    await setTimeout(300);
    console.log("Removed sp_message_container_ nodes (fallback).");
    return true;
  } catch (e) {
    console.log("Failed to remove sp_message_container_ nodes:", e.message);
    return false;
  }
}

async function run() {
  console.log("Start screenshot.js");

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    defaultViewport: { width: 1280, height: 900 }
  });

  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36");
  await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, "webdriver", { get: () => false }); });

  // Устанавливаем тему сайта через localStorage до загрузки
  const THEME = process.env.F1_THEME || "dark";  // либо "light"
  await page.goto("about:blank");
  await page.evaluate(theme => {
    try {
      sessionStorage.setItem("dark-mode", theme);
    } catch (e) {}
  }, THEME);
   
  console.log("Go to:", URL);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });

  // Ждём появления карточек (react)
  try {
    await page.waitForSelector("a.group", { timeout: 20000 });
  } catch (e) {
    console.warn("a.group not found in initial wait:", e.message);
  }

  // Небольшая пауза — даём React подгрузиться
  await setTimeout(1200);

  // Попробуем нажать Accept внутри iframe (наиболее корректно)
  let accepted = false;
  try {
    accepted = await clickAcceptInConsentFrame(page);
  } catch (e) {
    console.log("Error clicking consent frame:", e.message);
    accepted = false;
  }

  if (!accepted) {
    // Если не получилось нажать — пробуем удалить контейнеры (фоллбек)
    await removeSpMessageContainers(page);
  } else {
    // Если кликнули — подождём исчезновения контейнера
    try {
      await page.waitForFunction(() => !document.querySelector("div[id^='sp_message_container_']"), { timeout: 5000 });
      console.log("Consent container disappeared after click.");
    } catch (e) {
      console.log("Consent container did not disappear automatically after click; applying fallback removal.");
      await removeSpMessageContainers(page);
    }
  }

  // Небольшая стабилизация
  await setTimeout(700);

  // Сейчас берём HTML (после принятия/удаления баннера) и парсим
  const html = await page.content();
  const $ = cheerio.load(html);

  const cards = [];
  $("a.group").each((i, el) => {
    const $el = $(el);
    const title = $el.find("p.typography-module_display-xl-bold__Gyl5W").first().text().trim() || $el.find("p").first().text().trim();
    const dateFuture = $el.find("span.typography-module_technical-m-bold__JDsxP, span.typography-module_technical-m-bold__JDsxP.typography-module_lg_technical-l-bold__d8tzL").first().text().trim();
    const datePast = $el.find("span.typography-module_technical-xs-regular__-W0Gs").first().text().trim();
    const dateText = dateFuture || datePast || "";
    const parsed = parseRaceDate(dateText);
    if (parsed) cards.push({ index: i, title, dateText, parsed });
  });

  console.log("Parsed cards:", cards.length);
  //Debug files saving starts here
  console.log("Saving debug files…");
  fs.writeFileSync("debug.html", await page.content());
  await page.screenshot({ path: "debug.png", fullPage: true });
  //Debug files saving endpoint
  cards.slice(0,6).forEach((c,idx) => console.log(`#${idx}: ${c.title} — ${c.dateText}`));

  const now = new Date();
  // Normalize date (strip time)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const past = cards.filter(c => c.parsed && c.parsed.end < today).sort((a,b) => b.parsed.end - a.parsed.end);
  const nextCandidates = cards.filter(c => c.parsed && c.parsed.end >= today).sort((a,b) => a.parsed.start - b.parsed.start);

  const lastRace = past.length ? past[0] : null;
  const nextRace = nextCandidates.length ? nextCandidates[0] : null;

  console.log("Determined nextRace:", nextRace ? `${nextRace.title} ${nextRace.dateText}` : "NONE");
  console.log("Determined lastRace:", lastRace ? `${lastRace.title} ${lastRace.dateText}` : "NONE");

  // Получаем актуальные element handles
  const handles = await page.$$("a.group");
  console.log("Found handles:", handles.length);

  async function screenshotByCard(card, filename) {
    if (!card) {
      console.log("No card for", filename);
      return;
    }
    const idx = card.index;
    // снова находить handle, но берём из handles массив
    const handle = handles[idx];
    if (!handle) {
      console.warn("Handle not found by index, trying fallback by title...");
      // пробуем найти по тексту внутри DOM (evaluate)
      const found = await page.$$eval("a.group", (nodes, title) => {
        for (let i = 0; i < nodes.length; i++) {
          if ((nodes[i].innerText || "").includes(title)) return i;
        }
        return -1;
      }, card.title);
      if (found >= 0 && found < handles.length) {
        try {
          await handles[found].screenshot({ path: filename });
          console.log("Saved (fallback) ", filename);
          return;
        } catch (e) {
          console.error("Fallback screenshot failed:", e.message);
          return;
        }
      }
      return;
    }

    try {
      await handle.evaluate(el => el.scrollIntoView({ behavior: "auto", block: "center" }));
      await setTimeout(600);
      await handle.screenshot({ path: filename });
      console.log("Saved", filename);
    } catch (err) {
      console.error("Screenshot error for", filename, err.message);
    }
  }

  await screenshotByCard(nextRace, "f1_next_race.png");
  await screenshotByCard(lastRace, "f1_last_race.png");

  await browser.close();
  console.log("Finished.");
}

run().catch(err => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
