// screenshot.js — устойчивый вариант с анти-cookie и многоступенчатым ожиданием
import puppeteer from "puppeteer";
import fs from "fs";
import { setTimeout } from "node:timers/promises";

const URL = "https://www.formula1.com/en/racing/2025.html";

function parseRaceDate(text) {
    if (!text) return null;
    const nums = text.match(/\d+/g)?.map(Number) ?? [];
    const monthStr = text.match(/[A-Za-z]{3,}/)?.[0]?.slice(0, 3);
    if (!nums.length || !monthStr) return null;

    const monthMap = {
        Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5,
        Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11
    };

    const month = monthMap[monthStr];
    const year = 2025;

    return {
        start: new Date(year, month, nums[0]),
        end: new Date(year, month, nums[1] ?? nums[0])
    };
}

// Очень агрессивный убийца cookie/OneTrust
async function nukeCookies(page) {
    await page.evaluate(() => {
        const kill = () => {
            document.querySelectorAll("*").forEach(el => {
                const t = el.innerText?.toLowerCase() ?? "";
                const id = el.id?.toLowerCase() ?? "";
                const cls = el.className?.toLowerCase?.() ?? "";

                const bad = ["cookie", "consent", "privacy", "onetrust", "ot-", "manage"];
                if (bad.some(k => t.includes(k) || id.includes(k) || cls.includes(k))) {
                    el.remove();
                }

                const s = getComputedStyle(el);
                if ((s.position === "fixed" || s.position === "sticky") &&
                    parseInt(s.zIndex) > 900 &&
                    el.offsetHeight > 40) {
                    el.remove();
                }
            });
        };
        kill();
        setTimeout(kill, 500);
        setTimeout(kill, 1500);
        setTimeout(kill, 2500);
    });
    await setTimeout(1500);
}

// Получение карточек напрямую из DOM браузера
async function extractCards(page) {
    return await page.$$eval("a.group", nodes =>
        nodes.map((el, index) => {
            const title = el.querySelector("p.typography-module_display-xl-bold__Gyl5W")?.textContent.trim() ?? "";
            const date = el.querySelector("span.typography-module_technical-m-bold__JDsxP")?.textContent.trim() ??
                         el.querySelector("span.typography-module_technical-m-bold__JDsxP.typography-module_lg_technical-l-bold__d8tzL")?.textContent.trim() ??
                         "";
            const tag = el.querySelector("span.typography-module_body-2-xs-bold__M03Ei")?.textContent.trim() ?? "";

            return { index, title, date, tag };
        })
    );
}

async function run() {
    console.log("Launching Chromium…");

    const browser = await puppeteer.launch({
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-extensions",
            "--disable-blink-features=AutomationControlled"
        ],
        defaultViewport: { width: 1920, height: 1080 }
    });

    const page = await browser.newPage();

    // Anti-detection
    await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36"
    );
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    console.log("Opening:", URL);
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 0 });

    // Уничтожаем всё мешающее
    await nukeCookies(page);

    // Принудительный скролл — важен для React!
    await page.evaluate(() => window.scrollTo(0, 500));
    await setTimeout(800);
    await page.evaluate(() => window.scrollTo(0, 1500));
    await setTimeout(800);

    // Многоступенчатое ожидание карточек
    let cards = [];
    for (let i = 1; i <= 6; i++) {
        cards = await extractCards(page);
        console.log(`Attempt ${i}: found ${cards.length} cards`);
        if (cards.length > 10) break; // нормальная страница — 24+ карточек
        await setTimeout(1000 * i);
    }

    if (cards.length < 10) {
        console.error("Failed to load race cards. Saving debug files…");
        fs.writeFileSync("debug.html", await page.content());
        await page.screenshot({ path: "debug.png", fullPage: true });
        await browser.close();
        process.exit(1);
    }

    // Фильтруем TESTING
    cards = cards.filter(c => c.tag !== "TESTING" && c.date && c.title);

    // Добавляем даты
    cards.forEach(c => (c.parsed = parseRaceDate(c.date)));
    cards = cards.filter(c => c.parsed);

    const now = new Date();
    const future = cards.filter(c => c.parsed.end >= now).sort((a,b)=>a.parsed.start - b.parsed.start);
    const past = cards.filter(c => c.parsed.end < now).sort((a,b)=>b.parsed.end - a.parsed.end);

    const nextRace = future[0] ?? null;
    const lastRace = past[0] ?? null;

    console.log("Next:", nextRace?.title, nextRace?.date);
    console.log("Last:", lastRace?.title, lastRace?.date);

    const handles = await page.$$("a.group");

    async function screenshotCard(card, filename) {
        if (!card) {
            console.log("Skip screenshot:", filename);
            return;
        }
        const el = handles[card.index];
        if (!el) return console.log("No handle for", filename);

        await el.evaluate(el => el.scrollIntoView({ block: "center" }));
        await setTimeout(400);
        await el.screenshot({ path: filename });
        console.log("Saved:", filename);
    }

    await screenshotCard(nextRace, "f1_next_race.png");
    await screenshotCard(lastRace, "f1_last_race.png");

    await browser.close();
    console.log("Done.");
}

run().catch(err => {
    console.error("FATAL:", err);
    process.exit(1);
});
