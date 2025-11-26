import puppeteer from 'puppeteer';
import * as cheerio from 'cheerio';
import fs from 'fs';
import {setTimeout} from "node:timers/promises";

const URL = "https://www.formula1.com/en/racing/2025.html";

function parseRaceDate(dateText) {
  // Формат: "28 - 30 Nov" или "21 - 23 Mar"
  const parts = dateText.split(/\s+/).filter(Boolean); // ["28","-","30","Nov"]
  const dayEnd = parseInt(parts[2], 10);
  const monthStr = parts[3];
  const monthMap = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
  const month = monthMap[monthStr] ?? 0;
  const year = 2025;
  return new Date(year, month, dayEnd);
}

async function findBoundingBoxForRace(page, match) {
  // match: { title, dateText, isNextRace, preferFutureDateClass }
  // Возвращает { x, y, width, height } или null

  // Ждём, пока элемент группы вообще появится (максимум 10 секунд)
  await page.waitForSelector('a.group', { timeout: 10000 });

  // Выполняем в браузерном контексте поиск карточки по title + dateText
  const box = await page.evaluate((title, dateText) => {
    function textOf(el, selector) {
      const s = el.querySelector(selector);
      return s ? s.innerText.trim() : '';
    }

    const nodes = Array.from(document.querySelectorAll('a.group'));
    for (const n of nodes) {
      const titleText = textOf(n, 'p.typography-module_display-xl-bold__Gyl5W') ||
                        textOf(n, 'p.typography-module_display-xl-bold__Gyl5W.group-hover\\:underline'); // fallback if class changes slightly
      // Для будущих (next) дата в big class, для прошлых в-xs class — проверяем оба
      const dateBig = textOf(n, 'span.typography-module_technical-m-bold__JDsxP') || textOf(n, 'span.typography-module_technical-m-bold__JDsxP.typography-module_lg_technical-l-bold__d8tzL');
      const dateSmall = textOf(n, 'span.typography-module_technical-xs-regular__-W0Gs');

      const dateCandidates = [dateBig, dateSmall].filter(Boolean);
      const matchesTitle = title && titleText && titleText === title;
      const matchesDate = dateText && dateCandidates.some(d => d === dateText);

      // additionally allow matching by NEXT RACE label if title is empty
      const nextLabel = Array.from(n.querySelectorAll('span.typography-module_body-2-xs-bold__M03Ei')).map(s=>s.innerText.trim()).includes('NEXT RACE');

      if ((matchesTitle && matchesDate) || (nextLabel && dateBig === dateText) || (matchesTitle && !dateText && dateCandidates.length)) {
        const rect = n.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, dpr: window.devicePixelRatio || 1 };
      }
    }
    return null;
  }, match.title, match.dateText);

  return box;
}

async function run() {
  const browser = await puppeteer.launch({
    headless: true,
    defaultViewport: { width: 1280, height: 900 },
  });

  const page = await browser.newPage();
  // Увеличим таймаут навигации
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });

  // Немного подождём для отложенного рендера (если сайт рендерит спустя JS)
  await setTimeout(1000);

  const html = await page.content();
  const $ = cheerio.load(html);

  const cards = [];

  $('a.group').each((i, el) => {
    const element = $(el);

    const isNextRace = element.find('span.typography-module_body-2-xs-bold__M03Ei')
      .filter((_, s) => $(s).text().trim() === 'NEXT RACE').length > 0;

    const title = element.find('p.typography-module_display-xl-bold__Gyl5W').first().text().trim() || '';

    let dateText = '';

    const dateFuture = element.find('span.typography-module_technical-m-bold__JDsxP.typography-module_lg_technical-l-bold__d8tzL').first();
    if (dateFuture.length > 0) {
      dateText = dateFuture.text().trim();
    } else {
      const datePast = element.find('span.typography-module_technical-xs-regular__-W0Gs').first();
      if (datePast.length > 0) dateText = datePast.text().trim();
    }

    if (!dateText && !title) return; // пропускаем если ничего нет

    cards.push({
      title,
      dateText,
      date: dateText ? parseRaceDate(dateText) : null,
      isNextRace
    });
  });

  const now = new Date();

  const nextRace = cards.find(c => c.isNextRace) ||
    cards.filter(c => c.date && c.date >= now).sort((a,b)=>a.date - b.date)[0];

  const lastRace = cards.filter(c => c.date && c.date < now).sort((a,b)=>b.date - a.date)[0];

  console.log('Parsed cards:', cards.length);
  console.log('Next race (parsed):', nextRace?.title, nextRace?.dateText);
  console.log('Last race (parsed):', lastRace?.title, lastRace?.dateText);

  // Функция attempt — вызывает findBoundingBox и делает screenshot; добавляем retries
  async function attemptScreenshot(race, outFile) {
    if (!race) {
      console.log(`Нет данных для ${outFile}`);
      return;
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const box = await findBoundingBoxForRace(page, race);
        if (!box) {
          throw new Error('Bounding box не найден — DOM мог не отрендериться ещё.');
        }

        // Корректировка округлением и учёт DPR
        const dpr = box.dpr || 1;
        const clip = {
          x: Math.max(0, Math.floor(box.x * dpr)),
          y: Math.max(0, Math.floor(box.y * dpr)),
          width: Math.max(1, Math.floor(box.width * dpr)),
          height: Math.max(1, Math.floor(box.height * dpr))
        };

        await page.screenshot({ path: outFile, clip });
        console.log(`Saved ${outFile}`);
        return;
      } catch (err) {
        console.warn(`Попытка ${attempt} для ${outFile} не удалась: ${err.message}`);
        // если были несколько попыток — даём небольшой таймаут и повторяем
		await setTimeout(800 * attempt);
      }
    }
    console.error(`Не удалось сделать скрин ${outFile} после нескольких попыток.`);
  }

  await attemptScreenshot(nextRace, 'f1_next_race.png');
  await attemptScreenshot(lastRace, 'f1_last_race.png');

  await browser.close();
}

run().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
