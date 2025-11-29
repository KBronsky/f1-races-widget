// screenshot.js
// Saves 6 images:
// f1_last_race_wt.png, f1_next_race_wt.png,
// f1_last_race_bk.png, f1_next_race_bk.png,
// f1_racewidget_wt.png (composite), f1_racewidget_bk.png (composite)

import puppeteer from "puppeteer";
import * as cheerio from "cheerio";
import fs from "fs";
import { setTimeout as delay } from "node:timers/promises";

const URL = "https://www.formula1.com/en/racing/2025.html";

/* ---------- date parser ---------- */
function parseRaceDate(text) {
  if (!text) return null;
  const nums = text.match(/\d+/g)?.map(Number) ?? [];
  const monthMatch = text.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i);
  if (!nums.length || !monthMatch) return null;
  const monthMap = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
  const month = monthMap[monthMatch[0].slice(0,3)];
  const year = 2025;
  const start = new Date(year, month, nums[0]);
  const end = new Date(year, month, nums[1] ?? nums[0]);
  if (end < start) end.setFullYear(end.getFullYear() + 1);
  return { start, end };
}

/* ---------- consent iframe handling (click Accept) ---------- */
async function clickAcceptInConsentFrame(page) {
  const frames = page.frames();
  let consentFrame = frames.find(f => {
    try { return f.url().includes("consent.formula1.com"); } catch { return false; }
  });

  if (!consentFrame) {
    const iframeHandle = await page.$("iframe[id^='sp_message_iframe_']");
    if (iframeHandle) {
      consentFrame = await iframeHandle.contentFrame().catch(()=>null);
    }
  }

  if (!consentFrame) {
    console.log("Consent iframe not found.");
    return false;
  }

  // try multiple selectors/xpaths
  const selectors = [
    'button[aria-label="Accept all"]',
    'button[title="Accept all"]',
    'button[aria-label="Accept"]',
    'button[title="Accept"]'
  ];

  for (const sel of selectors) {
    try {
      const btn = await consentFrame.waitForSelector(sel, { timeout: 2500 });
      if (btn) {
        await btn.click().catch(()=>null);
        console.log("Clicked accept button via selector:", sel);
        return true;
      }
    } catch {}
  }

  // XPath fallback by text (case-insensitive)
  const xps = [
    "//button[contains(normalize-space(.),'Accept all')]",
    "//button[contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'accept all')]",
    "//button[contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'accept')]"
  ];

  for (const xp of xps) {
    try {
      const handles = await consentFrame.$x(xp);
      if (handles && handles.length) {
        await handles[0].click().catch(()=>null);
        console.log("Clicked accept button via xpath:", xp);
        return true;
      }
    } catch {}
  }

  console.log("Accept button not found inside consent iframe.");
  return false;
}

async function removeSpMessageContainers(page) {
  try {
    await page.evaluate(() => {
      document.querySelectorAll("div[id^='sp_message_container_']").forEach(e => e.remove());
    });
    await delay(300);
    console.log("Removed sp_message_container_ nodes (fallback).");
    return true;
  } catch (e) {
    console.log("Failed to remove sp_message_container_ nodes:", e.message);
    return false;
  }
}

/* ---------- helper: ensure cards loaded ---------- */
async function waitForCards(page, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    const count = await page.$$eval("a.group", els => els.length).catch(()=>0);
    if (count && count > 0) {
      return count;
    }
    await delay(1000 + i*200);
  }
  return 0;
}

/* ---------- core: capture for a theme ---------- */
async function captureForTheme(browser, theme, suffix) {
  const page = await browser.newPage();

  // set user agent + anti-detect
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36");
  await page.evaluateOnNewDocument((t) => {
    try {
      sessionStorage.setItem("dark-mode", t);
    } catch {}
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  }, theme);

  // navigate
  await page.goto("about:blank", { waitUntil: "domcontentloaded" });
  // Now go to target; evaluateOnNewDocument will set sessionStorage for the origin when loads
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });

  // wait for cards (React)
  const cnt = await waitForCards(page, 12);
  console.log(`[${theme}] initial card count: ${cnt}`);

  // small delay, then handle consent
  await delay(800);
  let accepted = false;
  try {
    accepted = await clickAcceptInConsentFrame(page);
  } catch (e) {
    accepted = false;
  }
  if (!accepted) {
    await removeSpMessageContainers(page);
  } else {
    try {
      await page.waitForFunction(() => !document.querySelector("div[id^='sp_message_container_']"), { timeout: 4000 }).catch(()=>null);
      await delay(400);
    } catch {}
  }

  // extra stabilization & scroll to trigger lazy loads
  await page.evaluate(() => { window.scrollTo(0, 400); });
  await delay(400);
  await page.evaluate(() => { window.scrollTo(0, 0); });
  await delay(400);

  // get html and parse with cheerio for consistent parsing logic
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

  console.log(`[${theme}] parsed ${cards.length} cards`);
  // determine next/last according to rule: next if today <= end
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const past = cards.filter(c => c.parsed && c.parsed.end < today).sort((a,b)=>b.parsed.end - a.parsed.end);
  const nextCandidates = cards.filter(c => c.parsed && c.parsed.end >= today).sort((a,b)=>a.parsed.start - b.parsed.start);

  const lastRace = past[0] ?? null;
  const nextRace = nextCandidates[0] ?? null;

  console.log(`[${theme}] next: ${nextRace ? nextRace.title + " " + nextRace.dateText : "NONE"}`);
  console.log(`[${theme}] last: ${lastRace ? lastRace.title + " " + lastRace.dateText : "NONE"}`);

  // take element handles live (avoid detached)
  const handles = await page.$$("a.group");
  async function screenshotCard(card, outPath) {
    if (!card) { console.log(`[${theme}] skip ${outPath} (no card)`); return false; }
    // find current index by scanning handles and matching title/date to be robust
    for (let i = 0; i < handles.length; i++) {
      try {
        const ok = await handles[i].evaluate((el, t, d) => {
          const text = (el.innerText || "").replace(/\s+/g," ").trim();
          return (t && text.includes(t)) || (d && text.includes(d));
        }, card.title, card.dateText);
        if (ok) {
          try {
            await handles[i].evaluate(el => el.scrollIntoView({ behavior: "auto", block: "center" }));
            await delay(500);
            await handles[i].screenshot({ path: outPath });
            console.log(`[${theme}] Saved ${outPath}`);
            return true;
          } catch (e) {
            console.warn(`[${theme}] Screenshot failed for ${outPath}:`, e.message);
            return false;
          }
        }
      } catch {
        // skip detached handle or evaluate error
      }
    }
    // fallback: attempt to find by text each time
    const foundIndex = await page.$$eval("a.group", (nodes, t, d) => {
      for (let k=0;k<nodes.length;k++){
        const text = (nodes[k].innerText||"").replace(/\s+/g," ").trim();
        if ((t && text.includes(t)) || (d && text.includes(d))) return k;
      }
      return -1;
    }, card.title, card.dateText).catch(()=>-1);

    if (foundIndex >=0) {
      try {
        const handlesNow = await page.$$("a.group");
        await handlesNow[foundIndex].evaluate(el => el.scrollIntoView({ behavior: "auto", block: "center" }));
        await delay(400);
        await handlesNow[foundIndex].screenshot({ path: outPath });
        console.log(`[${theme}] Saved (fallback) ${outPath}`);
        return true;
      } catch (e) {
        console.warn(`[${theme}] Fallback screenshot failed:`, e.message);
        return false;
      }
    }

    console.warn(`[${theme}] Could not locate element for ${outPath}`);
    return false;
  }

  const okNext = await screenshotCard(nextRace, `f1_next_race_${suffix}.png`);
  const okLast = await screenshotCard(lastRace, `f1_last_race_${suffix}.png`);

  await page.close();

  return {
    theme,
    suffix,
    nextRace, lastRace,
    okNext, okLast
  };
}

/* ---------- combine images horizontally using sharp (if available) ---------- */
async function combineImages(leftPath, rightPath, outPath) {
  try {
    const sharpModule = await import('sharp');
    const sharp = sharpModule.default ?? sharpModule;
    // read buffers
    const left = fs.readFileSync(leftPath);
    const right = fs.readFileSync(rightPath);
    const imgL = sharp(left);
    const imgR = sharp(right);
    const metaL = await imgL.metadata();
    const metaR = await imgR.metadata();
    // scale heights to the same max height (choose min of heights to avoid upscaling)
    const targetHeight = Math.min(metaL.height || 0, metaR.height || 0) || Math.max(metaL.height||0, metaR.height||0);
    const bufL = await imgL.resize({ height: targetHeight }).toBuffer();
    const bufR = await imgR.resize({ height: targetHeight }).toBuffer();
    // join horizontally
    const composite = await sharp({
      create: {
        width: 1, height: targetHeight, channels: 4, background: { r: 0, g:0, b:0, alpha:0 }
      }
    })
    .png()
    .toBuffer();

    // simplest: use sharp's join via svg canvas: create an SVG with two images embedded base64
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${metaL.width + metaR.width}" height="${targetHeight}">
      <image href="data:image/png;base64,${bufL.toString('base64')}" x="0" y="0" height="${targetHeight}" />
      <image href="data:image/png;base64,${bufR.toString('base64')}" x="${metaL.width}" y="0" height="${targetHeight}" />
    </svg>`;
    const outBuf = await sharp(Buffer.from(svg)).png().toBuffer();
    fs.writeFileSync(outPath, outBuf);
    console.log("Combined image created:", outPath);
    return true;
  } catch (e) {
    console.warn("combineImages: sharp not available or failed:", e.message);
    console.warn("To enable combining, run: npm install sharp");
    return false;
  }
}

/* ---------- main ---------- */
async function main() {
  console.log("Starting screenshot sequence (light + dark)...");
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-blink-features=AutomationControlled"
    ],
    defaultViewport: { width: 1280, height: 900 }
  });

  // capture for light theme
  const resWt = await captureForTheme(browser, "light", "wt").catch(err => {
    console.error("Error captureForTheme light:", err);
    return null;
  });

  // capture for dark theme
  const resBk = await captureForTheme(browser, "dark", "bk").catch(err => {
    console.error("Error captureForTheme dark:", err);
    return null;
  });

  await browser.close();

  // Try combine for white theme
  const leftWt = "f1_last_race_wt.png";
  const rightWt = "f1_next_race_wt.png";
  if (fs.existsSync(leftWt) && fs.existsSync(rightWt)) {
    await combineImages(leftWt, rightWt, "f1_racewidget_wt.png");
  } else {
    console.warn("Skipping combine white theme — files missing.");
  }

  // Combine for dark theme
  const leftBk = "f1_last_race_bk.png";
  const rightBk = "f1_next_race_bk.png";
  if (fs.existsSync(leftBk) && fs.existsSync(rightBk)) {
    await combineImages(leftBk, rightBk, "f1_racewidget_bk.png");
  } else {
    console.warn("Skipping combine dark theme — files missing.");
  }

  console.log("Done. Output files (if captured):");
  ["f1_last_race_wt.png","f1_next_race_wt.png","f1_last_race_bk.png","f1_next_race_bk.png","f1_racewidget_wt.png","f1_racewidget_bk.png"]
    .forEach(f => { if (fs.existsSync(f)) console.log(" - " + f); });

}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
