import puppeteer from "puppeteer";
import * as cheerio from "cheerio";
import fs from "fs";

const URL = "https://www.formula1.com/en/racing/2025.html";

async function getRaces(page) {
    const html = await page.content();
    const $ = cheerio.load(html);

    const races = [];

    $(".f1-event-card").each((i, el) => {
        const title = $(el).find(".f1-bold--xs").first().text().trim() ||
                      $(el).find("h3").text().trim();
        
        const dateRaw = $(el)
            .find('.typography-module_technical-xs-regular__-W0Gs')
            .first()
            .text()
            .trim();

        // Пример: "21 - 23 Mar"
        const parsedDate = parseRaceDate(dateRaw);

        races.push({
            title,
            dateRaw,
            dateStart: parsedDate?.start || null,
            dateEnd: parsedDate?.end || null,
            element: el
        });
    });

    return races;
}

function parseRaceDate(str) {
    if (!str) return null;

    // Форматы:
    // "21 - 23 Mar"
    // "5 - 7 Sep"
    // "30 Nov - 2 Dec"

    const parts = str.split(" ");

    if (parts.length < 3) return null;

    const dayStart = parseInt(parts[0]);
    const dayEnd = parseInt(parts[2]);
    const monthRaw = parts[3] || parts[2];
    const month = monthRaw.substring(0, 3);

    const monthMap = {
        Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
        Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
    };

    const year = 2025;

    return {
        start: new Date(year, monthMap[month], dayStart),
        end: new Date(year, monthMap[month], dayEnd)
    };
}

async function takeScreenshot(page, element, filename) {
    const clip = await element.boundingBox();
    if (!clip) {
        throw new Error("Bounding box not found for screenshot.");
    }
    await page.screenshot({ path: filename, clip });
}

async function main() {
    const browser = await puppeteer.launch({
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-blink-features=AutomationControlled",
            "--disable-dev-shm-usage",
            "--disable-gpu"
        ]
    });

    const page = await browser.newPage();

    // Anti-bot headers
    await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
    );

    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, "webdriver", {
            get: () => false
        });
    });

    await page.setViewport({ width: 1920, height: 1080 });

    await page.goto(URL, {
        waitUntil: "networkidle2",
        timeout: 0
    });

    // Extra wait for scripts + styles
    await page.waitForNetworkIdle({ timeout: 10000 });

    const races = await getRaces(page);

    const now = new Date();

    const pastRaces = races.filter(r => r.dateEnd && r.dateEnd < now);
    const nextRaces = races.filter(r => r.dateStart && r.dateStart > now);

    const lastRace = pastRaces[pastRaces.length - 1];
    const nextRace = nextRaces[0];

    if (lastRace) {
        const handle = await page.$(".f1-event-card:nth-of-type(" + (races.indexOf(lastRace)+1) + ")");
        await handle.scrollIntoView();
        await page.waitForTimeout(1000);

        await takeScreenshot(page, handle, "f1_last_race.png");
        console.log("Saved f1_last_race.png");
    } else {
        console.log("No past races found.");
    }

    if (nextRace) {
        const handle = await page.$(".f1-event-card:nth-of-type(" + (races.indexOf(nextRace)+1) + ")");
        await handle.scrollIntoView();
        await page.waitForTimeout(1000);

        await takeScreenshot(page, handle, "f1_next_race.png");
        console.log("Saved f1_next_race.png");
    } else {
        console.log("No next races found.");
    }

    await browser.close();
}

main().catch(err => console.error(err));
