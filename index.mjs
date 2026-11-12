// web - https://www.myhome.ge/udzravi-qoneba/qiravdeba/bina/tbilisi/lisis-mimdebared/?deal_types=2&...
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import http from 'http';
import {chromium} from 'playwright';

const API_COUNT_URL = 'https://api-statements.tnet.ge/v1/statements/count';
const SEARCH_PATH = '/udzravi-qoneba/qiravdeba/bina/tbilisi/lisis-mimdebared/';
const LOCALE = 'ka';
const SLUGS = ['udzravi-qoneba', 'qiravdeba', 'bina', 'tbilisi', 'lisis-mimdebared'];

const FILTERS = {
    deal_types: 2,
    real_estate_types: [1, 5],
    cities: 1,
    urbans: [101, 28, 38, 42, 43, 47, 63, 64, 65, 66, 67, 61, 62, 107, 57, 23, 24, 25, 27, 103, 26, 10, 11],
    districts: [4, 6, 3, 1],
    currency_id: 1,
    price_to: 1200,
    area_from: 60,
    area_types: 1,
};

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

axios.defaults.timeout = 30000;
axios.defaults.headers.common['X-Website-Key'] = 'myhome';

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '9217953409:AAHxMTBU9v3h0aws9LuSnwQXxjBVFNmnbt0';
const CHAT_ID = process.env.CHAT_ID || '-5363209604';

const bot = new TelegramBot(TELEGRAM_TOKEN, {polling: true});

let StoreRealEstateIds = new Map();
let isFirstRun = true;
let isFetching = false;

let browser;
let browserContext;
let sessionPage;
let cachedBuildId = null;

console.log('worker started!!!');

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/health') {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({
            status: 'ok',
            service: 'ninoPatriot',
            uptime: process.uptime(),
            tracked: StoreRealEstateIds.size,
        }));
    } else {
        res.writeHead(404, {'Content-Type': 'text/plain'});
        res.end('Not Found');
    }
});

server.listen(PORT, () => {
    console.log(`Health check server running on port ${PORT}`);
});

const toQuery = (page) => {
    const params = new URLSearchParams();
    params.set('deal_types', String(FILTERS.deal_types));
    params.set('real_estate_types', FILTERS.real_estate_types.join(','));
    params.set('cities', String(FILTERS.cities));
    params.set('urbans', FILTERS.urbans.join(','));
    params.set('districts', FILTERS.districts.join(','));
    params.set('currency_id', String(FILTERS.currency_id));
    params.set('price_to', String(FILTERS.price_to));
    params.set('area_from', String(FILTERS.area_from));
    params.set('area_types', String(FILTERS.area_types));
    params.set('page', String(page));
    return params;
};

const searchPageUrl = (page) => `https://www.myhome.ge${SEARCH_PATH}?${toQuery(page).toString()}`;

const extractListings = (payload) => {
    // __NEXT_DATA__ => props.pageProps ; _next/data JSON => pageProps
    const pageProps = payload?.props?.pageProps || payload?.pageProps;
    const queries = pageProps?.dehydratedState?.queries;
    if (!Array.isArray(queries)) {
        return [];
    }

    for (const query of queries) {
        const key = query?.queryKey;
        if (Array.isArray(key) && key[0] === 'statements' && key[1] === 'list') {
            const listings = query?.state?.data?.data?.data;
            if (Array.isArray(listings)) {
                return listings;
            }
        }
    }

    return [];
};

const ensureBrowser = async () => {
    if (browser && browserContext) {
        return browserContext;
    }

    console.log('Launching browser...');
    browser = await chromium.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
        ],
    });

    browserContext = await browser.newContext({
        userAgent: USER_AGENT,
        locale: 'ka-GE',
        viewport: {width: 1440, height: 900},
        extraHTTPHeaders: {
            'accept-language': 'ka-GE,ka;q=0.9,en-US;q=0.8,en;q=0.7',
        },
    });

    return browserContext;
};

const resetBrowser = async () => {
    cachedBuildId = null;
    try {
        if (sessionPage) await sessionPage.close();
    } catch (_) {}
    try {
        if (browserContext) await browserContext.close();
    } catch (_) {}
    try {
        if (browser) await browser.close();
    } catch (_) {}
    sessionPage = null;
    browserContext = null;
    browser = null;
};

const warmUpSession = async () => {
    const context = await ensureBrowser();

    if (sessionPage) {
        try {
            await sessionPage.close();
        } catch (_) {}
    }

    sessionPage = await context.newPage();
    const url = searchPageUrl(1);
    console.log('Warming Cloudflare session via', url);

    await sessionPage.goto(url, {waitUntil: 'domcontentloaded', timeout: 120000});

    await sessionPage.waitForFunction(() => {
        const title = document.title || '';
        if (title.includes('Just a moment')) return false;
        return Boolean(document.querySelector('#__NEXT_DATA__'));
    }, {timeout: 120000});

    const boot = await sessionPage.evaluate(() => {
        const el = document.querySelector('#__NEXT_DATA__');
        if (!el) return null;
        try {
            return JSON.parse(el.textContent);
        } catch {
            return null;
        }
    });

    if (!boot?.buildId) {
        throw new Error('Could not read Next.js buildId after page load');
    }

    cachedBuildId = boot.buildId;
    console.log('Cloudflare session ready, buildId =', cachedBuildId);
    return {buildId: cachedBuildId, firstPageListings: extractListings(boot)};
};

const fetchListingsPageInBrowser = async (buildId, pageNum) => {
    if (!sessionPage) {
        throw new Error('No browser session page');
    }

    const qs = toQuery(pageNum).toString();
    const slugQs = SLUGS.map((s) => `slug=${encodeURIComponent(s)}`).join('&');
    const path = `/_next/data/${buildId}/${LOCALE}/${SLUGS.join('/')}.json?${qs}&${slugQs}`;

    const result = await sessionPage.evaluate(async (requestPath) => {
        const response = await fetch(requestPath, {
            headers: {'x-nextjs-data': '1'},
        });
        const text = await response.text();
        return {status: response.status, text};
    }, path);

    if (result.status !== 200) {
        const err = new Error(`Next data HTTP ${result.status} for page ${pageNum}`);
        err.status = result.status;
        err.body = result.text.slice(0, 200);
        throw err;
    }

    let json;
    try {
        json = JSON.parse(result.text);
    } catch (parseError) {
        const err = new Error(`Invalid JSON for page ${pageNum}`);
        err.body = result.text.slice(0, 200);
        throw err;
    }

    return extractListings(json);
};

const processListings = async (realestates) => {
    for (const realEstate of realestates) {
        const realEstateId = realEstate.id;
        const price = realEstate.price?.['1']?.price_total;
        const priceSquare = realEstate.price?.['1']?.price_square;
        if (price == null) continue;

        const realEstateUrl = `https://www.myhome.ge/pr/${realEstateId}/details/`;

        if (isFirstRun) {
            StoreRealEstateIds.set(realEstateId, price);
            continue;
        }

        if (!StoreRealEstateIds.has(realEstateId)) {
            StoreRealEstateIds.set(realEstateId, price);
            try {
                await bot.sendMessage(
                    CHAT_ID,
                    `დაემატა ახალი:\n` +
                    `ფასი: ${price}₾\n` +
                    `კვ.მ: ${priceSquare}₾\n` +
                    `${realEstateUrl}`
                );
            } catch (telegramError) {
                console.error('Error sending Telegram message:', telegramError.message);
            }
        } else if (StoreRealEstateIds.get(realEstateId) != price) {
            const previousPrice = StoreRealEstateIds.get(realEstateId);
            const priceDifference = price - previousPrice;
            StoreRealEstateIds.set(realEstateId, price);
            try {
                await bot.sendMessage(
                    CHAT_ID,
                    `Price change detected: \n` +
                    `Previous Price:   ${previousPrice}₾\n` +
                    `Current Price:    ${price}₾\n` +
                    `Price Difference: ${priceDifference}₾\n` +
                    `${realEstateUrl}`
                );
            } catch (telegramError) {
                console.error('Error sending Telegram message:', telegramError.message);
            }
        }
    }
};

const fetchCars = async () => {
    if (isFetching) {
        console.log('Previous fetch still running, skipping this tick');
        return;
    }

    isFetching = true;
    console.log('loop started!!!');

    try {
        const countResponse = await axios.get(API_COUNT_URL, {
            params: {...FILTERS, page: 1},
            headers: {'X-Website-Key': 'myhome'},
        });

        const lastPage = countResponse.data.data.last_page;
        const total = countResponse.data.data.total;
        console.log('total pages', lastPage);
        console.log('total statements', total);

        // After baseline is built, only scan first pages (new listings show up first).
        const pagesToScan = isFirstRun ? lastPage : Math.min(3, lastPage);

        let buildId = cachedBuildId;
        let firstPageListings = null;

        if (!buildId || !sessionPage) {
            const warmed = await warmUpSession();
            buildId = warmed.buildId;
            firstPageListings = warmed.firstPageListings;
        }

        for (let currentPage = 1; currentPage <= pagesToScan; currentPage++) {
            let listings;

            try {
                if (currentPage === 1 && firstPageListings) {
                    listings = firstPageListings;
                    firstPageListings = null;
                } else {
                    listings = await fetchListingsPageInBrowser(buildId, currentPage);
                }
            } catch (pageError) {
                console.warn(`Page ${currentPage} failed (${pageError.message}). Refreshing session...`);
                await resetBrowser();
                const warmed = await warmUpSession();
                buildId = warmed.buildId;
                if (currentPage === 1) {
                    listings = warmed.firstPageListings;
                } else {
                    listings = await fetchListingsPageInBrowser(buildId, currentPage);
                }
            }

            console.log(`page ${currentPage}: ${listings.length} listings`);
            await processListings(listings);

            if (listings.length === 0 && currentPage > 1) {
                break;
            }
        }

        if (isFirstRun) {
            isFirstRun = false;
            console.log(`Baseline ready. Tracking ${StoreRealEstateIds.size} listings.`);
        }
    } catch (error) {
        console.error('Error fetching real estates:', error.message);
        if (error.body) {
            console.error('Response snippet:', error.body);
        }
        await resetBrowser();
    } finally {
        isFetching = false;
    }
};

const shutdown = async () => {
    await resetBrowser();
    process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

setInterval(fetchCars, 2 * 60 * 1000);
fetchCars();
