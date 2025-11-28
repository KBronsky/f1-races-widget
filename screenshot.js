// screenshot.js — финальная стабильная версия
import puppeteer from "puppeteer";
import { setTimeout } from "node:timers/promises";

// URL сезона
const URL = "https://www.formula1.com/en/racing/2025.html";

// Парсим строку вида "28 - 30 Nov"
function parseRaceDate(text) {
    if (!text) return null;

    const nums = text.match(/\d+/g)?.map(Number) ?? [];
    const monthStr = text.match(/[A-Za-z]{3,}/)?.[0]?.slice(0, 3);

    if (!nums.length || !monthStr) return null;

    const monthMap = {
        Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
        Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
    };

    const month = monthMap[monthStr];
    const year = 2025;

    let start = nums[0];
    let end = nums[1] ?? nums[0];

    return {
        start: new Date(year, month, start),
        end: new Date(year, month, end)
    };
}

// Удаляем баннеры куки/оверлеи
async function killCookieBanners(page) {
    await page.evaluate(() => {
        const keywords = ["cookie", "consent", "privacy", "agree", "manage"];

        document.querySelectorAll("*").forEach(el => {
            const t = el.innerText?.toLowerCase() ?? "";
            if (keywords.some(k => t.includes(k))) el.remove();

            const s = getComputedStyle(el);
            if (
                (s.position === "fixed" || s.position === "sticky") &&
                parseInt(s.zIndex) > 999 &&
                el.offsetHeight > 50
            ) el.remove();
        });
    });

    await setTimeout(800);
}

// Основная функция
async function run() {
    console.log("Launching Chromium...");

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

    console.log("Opening page:", URL);
    await page.goto(URL, { waitUntil: "networkidle0", timeout: 0 });

    await killCookieBanners(page);

    console.log("Waiting for race cards…");
    await page.waitForFunction(() => {
        return document.querySelectorAll("a.group").length > 10;
    }, { timeout: 20000 });

    // Получаем данные гонок прямо из браузера
    const cards = await page.$$eval("a.group", nodes => {
        return nodes.map((el, index) => {
            const title = el.querySelector("p.typography-module_display-xl-bold__Gyl5W")?.textContent?.trim() || "";
            const flag = el.querySelector("svg[role=img] title")?.textContent?.trim() || "";
            const date = el.querySelector("span.typography-module_technical-m-bold__JDsxP, span.typography-module_technical-m-bold__JDsxP.typography-module_lg_technical-l-bold__d8tzL")
                ?.textContent?.trim() || "";
            const tag = el.querySelector("span.typography-module_body-2-xs-bold__M03Ei")?.textContent?.trim() || "";

            return {
                index,
                title,
                flag,
                date,
                tag // TESTING / SPRINT / NEXT RACE etc
            };
        });
    });

    console.log("Total raw cards:", cards.length);

    // Фильтруем TESTING
    const raceCards = cards.filter(c =>
        c.tag.toUpperCase() !== "TESTING" &&
        c.title.length > 0 &&
        c.date.length > 0
    );

    console.log("Race cards:", raceCards.length);

    const now = new Date();

    // Добавляем дату
    raceCards.forEach(c => {
        c.parsed = parseRaceDate(c.date);
    });

    // Отбрасываем все без даты
    const valid = raceCards.filter(c => c.parsed);
    console.log("Valid cards:", valid.length);

    // Определяем next и last
    let nextRace = null;
    let lastRace = null;

    const futureCandidates = valid.filter(c => c.parsed.end >= now);
    const pastCandidates = valid.filter(c => c.parsed.end < now);

    nextRace = futureCandidates.sort((a, b) => a.parsed.start - b.parsed.start)[0] ?? null;
    lastRace = pastCandidates.sort((a, b) => b.parsed.end - a.parsed.end)[0] ?? null;

    console.log("Next race:", nextRace?.title, nextRace?.date);
    console.log("Last race:", lastRace?.title, lastRace?.date);

    // Получаем хэндлы элементов
    const handles = await page.$$("a.group");

    async function takeCardScreenshot(card, filename) {
        if (!card) {
            console.log("No card -> skip", filename);
            return;
        }

        const handle = handles[card.index];
        if (!handle) {
            console.log("Card handle missing:", card.title);
            return;
        }

        await handle.evaluate(el =>
            el.scrollIntoView({ behavior: "auto", block: "center" })
        );
        await setTimeout(600);

        await handle.screenshot({ path: filename });
        console.log("Saved", filename);
    }

    await takeCardScreenshot(nextRace, "f1_next_race.png");
    await takeCardScreenshot(lastRace, "f1_last_race.png");

    await browser.close();
    console.log("Finished.");
}

run().catch(err => {
    console.error("Fatal:", err);
    process.exit(1);
});
