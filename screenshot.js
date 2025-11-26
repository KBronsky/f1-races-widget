import puppeteer from 'puppeteer';
import * as cheerio from 'cheerio';
import fs from 'fs';
import { setTimeout } from "node:timers/promises";

const URL = "https://www.formula1.com/en/racing/2025.html";

function parseRaceDate(dateText) {
  const parts = dateText.split(/\s+/).filter(Boolean);
  const dayEnd = parseInt(parts[2], 10);
  const monthStr = parts[3];
  const monthMap = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
  const month = monthMap[monthStr] ?? 0;
  return new Date(2025, month, dayEnd);
}

async function findBoundingBoxForRace(page, match) {
  await page.waitForSelector('a.group', { timeout: 30000 });

  // стабилизатор DOM после рендера React
  await setTimeout(600);

  const box = await page.evaluate((title, dateText) => {
    function t(el, sel) {
      const s = el.querySelector(sel);
      return s ? s.innerText.trim() : '';
    }

    const nodes = Array.from(document.querySelectorAll('a.group'));
    for (const n of nodes) {
      const titleText =
        t(n,'p.typography-module_display-xl-bold__Gyl5W') ||
        t(n,'p.typography-module_display-xl-bold__Gyl5W.group-hover\\:underline');

      const dateBig =
        t(n,'span.typography-module_technical-m-bold__JDsxP') ||
        t(n,'span.typography-module_technical-m-bold__JDsxP.typography-module_lg_technical-l-bold__d8tzL');

      const dateSmall = t(n,'span.typography-module_technical-xs-regular__-W0Gs');

      const candidates = [dateBig, dateSmall].filter(Boolean);
      const matchTitle = titleText === title;
      const matchDate = dateText && candidates.includes(dateText);

      const nextLabel = Array.from(
        n.querySelectorAll('span.typography-module_body-2-xs-bold__M03Ei')
      ).some(x => x.innerText.trim() === 'NEXT RACE');

      if ((matchTitle && matchDate) || (nextLabel && dateBig === dateText)) {
        const r = n.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height, dpr: window.devicePixelRatio };
      }
    }
    return null;
  }, match.title, match.dateText);

  return box;
}

async function run() {
  const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage', 
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-web-security'
  ],
  defaultViewport: { width: 1280, height: 900 },
});

  const page = await browser.newPage();

  // ------------- предотвращаем redirect и ускоряем загрузку -------------
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (['image', 'stylesheet', 'media', 'font'].includes(req.resourceType()))
      req.abort();
    else
      req.continue();
  });
  // ----------------------------------------------------------------------

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  await page.waitForSelector('a.group', { timeout: 30000 });
  await setTimeout(800);

  const html = await page.content();
  const $ = cheerio.load(html);

  const cards = [];

  $('a.group').each((i, el) => {
    const element = $(el);

    const isNextRace = element.find('span.typography-module_body-2-xs-bold__M03Ei')
      .filter((_, s) => $(s).text().trim() === 'NEXT RACE').length > 0;

    const title = element.find('p.typography-module_display-xl-bold__Gyl5W').first().text().trim();

    let dateText = '';
    const future = element.find('span.typography-module_technical-m-bold__JDsxP.typography-module_lg_technical-l-bold__d8tzL').first();
    const past = element.find('span.typography-module_technical-xs-regular__-W0Gs').first();

    if (future.length) dateText = future.text().trim();
    else if (past.length) dateText = past.text().trim();

    if (!title && !dateText) return;

    cards.push({
      title,
      dateText,
      date: parseRaceDate(dateText),
      isNextRace
    });
  });

  const now = new Date();

  const nextRace = cards.find(c => c.isNextRace)
    || cards.filter(c => c.date >= now).sort((a,b)=>a.date - b.date)[0];

  const lastRace = cards.filter(c => c.date < now).sort((a,b)=>b.date - a.date)[0];

  console.log('Parsed cards:', cards.length);

  async function makeScreenshot(race, file) {
    if (!race) return;

    for (let i = 1; i <= 3; i++) {
      try {
        const box = await findBoundingBoxForRace(page, race);
        if (!box) throw new Error("Bounding box not found");

        const clip = {
          x: Math.floor(box.x * box.dpr),
          y: Math.floor(box.y * box.dpr),
          width: Math.floor(box.width * box.dpr),
          height: Math.floor(box.height * box.dpr),
        };

        await page.screenshot({ path: file, clip });
        console.log("Saved:", file);
        return;
      } catch (e) {
        console.log(`Retry ${i} for ${file}:`, e.message);
        await setTimeout(500 * i);
      }
    }

    console.error("Failed:", file);
  }

  await makeScreenshot(nextRace, 'f1_next_race.png');
  await makeScreenshot(lastRace, 'f1_last_race.png');

  await browser.close();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});

