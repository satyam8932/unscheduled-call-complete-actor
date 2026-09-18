import { Actor, log } from 'apify';
import { chromium, BrowserContext, Page } from 'playwright';
import { resolve } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';

interface ActorInput {
    subAccountUrl: string;
    leadName: string;
    storageState?: any;
    loginMode?: boolean;
    screenshotOnly?: boolean;
}

interface CallInfo {
    callFound: boolean;
    duration: string | null;
    durationSeconds: number;
    meetsThreshold: boolean;
    screenshotUrl: string | null;
}

interface ActorOutput {
    leadFound: boolean;
    leadName: string;
    callFound: boolean;
    duration: string | null;
    durationSeconds: number;
    meetsThreshold: boolean;
    screenshotUrl: string | null;
    error: string | null;
}

const LOCAL_STORAGE_STATE = resolve(process.cwd(), 'storage-state.json');
const CDP_ENDPOINT = 'http://127.0.0.1:9222';
const DURATION_THRESHOLD_SECONDS = 300;
const SCROLL_CONTAINER_ATTR = 'data-call-scroll-container';
const BOTTOM_TOLERANCE_PX = 8;

async function retry<T>(
    fn: () => Promise<T>,
    { attempts = 3, delayMs = 1000, label = 'operation' } = {}
): Promise<T> {
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (err: any) {
            if (i === attempts - 1) throw err;
            log.warning(`${label} failed (attempt ${i + 1}/${attempts}): ${err.message}. Retrying in ${delayMs}ms...`);
            await new Promise(r => setTimeout(r, delayMs));
            delayMs *= 2;
        }
    }
    throw new Error('Unreachable');
}

function parseDuration(timeStr: string): { duration: string; seconds: number } | null {
    const match = timeStr.match(/(\d+):(\d{2})/);
    if (!match) return null;
    const minutes = parseInt(match[1], 10);
    const seconds = parseInt(match[2], 10);
    return { duration: `${minutes}:${seconds.toString().padStart(2, '0')}`, seconds: minutes * 60 + seconds };
}

async function getContext(input: ActorInput): Promise<{ context: BrowserContext; persistent: boolean }> {
    const isCloud = Actor.isAtHome();

    if (!isCloud) {
        try {
            log.info('Connecting to a running Chromium instance via CDP on port 9222...');
            const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
            const contexts = browser.contexts();
            if (contexts.length > 0) {
                return { context: contexts[0], persistent: true };
            }
            const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
            return { context, persistent: false };
        } catch {
            log.warning('CDP connection failed. Start Chromium with --remote-debugging-port=9222, or use storage-state.json / loginMode=true instead.');
        }

        if (existsSync(LOCAL_STORAGE_STATE)) {
            log.info('Using local storage-state.json (headless, bundled Chromium)');
            const browser = await chromium.launch({
                headless: true,
                args: ['--disable-blink-features=AutomationControlled', '--disable-gpu'],
            });
            const context = await browser.newContext({
                storageState: LOCAL_STORAGE_STATE,
                viewport: { width: 1440, height: 900 },
            });
            return { context, persistent: false };
        }

        throw new Error('Cannot authenticate. Connect a browser via CDP or run with loginMode=true');
    }

    log.info('Running on Apify cloud...');
    if (!input.storageState) {
        throw new Error('No storageState in input. Pass browser session JSON as "storageState" field.');
    }

    const browser = await chromium.launch({
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-default-apps',
            '--disable-sync',
            '--no-first-run',
            '--disable-software-rasterizer',
            '--disable-translate',
            '--disable-hang-monitor',
        ],
    });
    const context = await browser.newContext({
        storageState: input.storageState as any,
        viewport: { width: 1440, height: 900 },
    });

    // Block non-essential resources on cloud to save RAM (keep CSS — SPA needs it to render)
    await context.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (['font', 'media', 'image'].includes(type)) {
            return route.abort();
        }
        return route.continue();
    });

    return { context, persistent: false };
}

async function runLoginMode(): Promise<void> {
    log.info('=== LOGIN MODE ===');
    log.info('Launching bundled Chromium for manual login...');
    const browser = await chromium.launch({
        headless: false,
        args: ['--disable-blink-features=AutomationControlled'],
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto('https://app.tjbdigitalservices.com/');

    log.info('Waiting for login... will save session once you reach any dashboard.');
    await page.waitForURL(url => {
        const path = new URL(url).pathname;
        return path.includes('/dashboard') || path.includes('/v2/location') || path.includes('/agency_dashboard');
    }, { timeout: 300000 });

    const state = await context.storageState();
    writeFileSync(LOCAL_STORAGE_STATE, JSON.stringify(state, null, 2));
    log.info(`Storage state saved to ${LOCAL_STORAGE_STATE}`);

    await browser.close();
    log.info('Login mode complete.');
}

async function searchAndClickLead(page: Page, leadName: string): Promise<boolean> {
    await page.waitForSelector('#globalSearchOpener', { state: 'visible', timeout: 60000 });
    await page.waitForTimeout(1000);

    await retry(async () => {
        log.info('Clicking global search...');
        await page.locator('#globalSearchOpener').click();
        await page.waitForTimeout(1000);
        await page.locator('#global-search-input').waitFor({ state: 'visible', timeout: 15000 });
    }, { attempts: 3, delayMs: 2000, label: 'open search popup' });

    log.info('Search popup visible, typing lead name...');
    await page.click('#global-search-input');
    await page.keyboard.type(leadName, { delay: 30 });

    log.info('Waiting for search results...');
    await page.waitForTimeout(3500);

    const noResult = page.getByText('No matching result', { exact: false });
    if (await noResult.count() > 0 && await noResult.first().isVisible()) {
        log.warning(`Lead not found: "${leadName}" — no matching result.`);
        return false;
    }

    // Strong name matching: find best result excluding "(2)", "(3)" suffixed duplicates
    async function findBestResult(): Promise<{ found: boolean; index: number }> {
        const allMatches = page.getByText(leadName, { exact: false });
        const count = await allMatches.count();
        if (count === 0) return { found: false, index: -1 };

        // Evaluate all visible matches and pick best one
        let bestIndex = 0;
        for (let i = 0; i < count; i++) {
            const el = allMatches.nth(i);
            if (!await el.isVisible().catch(() => false)) continue;
            const text = (await el.innerText().catch(() => '') || '').trim();
            log.info(`Search result [${i}]: "${text.substring(0, 60)}"`);
            // Reject results with "(2)", "(3)" etc — duplicate contact indicators
            const firstLine = text.split('\n')[0].trim();
            if (firstLine === leadName) {
                log.info(`Exact match found at index ${i}`);
                return { found: true, index: i };
            }
            // If first line has parenthetical suffix like "Name (2)", skip it
            if (/\(\d+\)/.test(firstLine)) {
                log.info(`Skipping duplicate indicator: "${firstLine}"`);
                continue;
            }
            bestIndex = i;
        }
        return { found: true, index: bestIndex };
    }

    const { found: resultFound, index: bestIdx } = await findBestResult();
    if (!resultFound) {
        log.warning(`Lead not found: "${leadName}" — no result appeared.`);
        return false;
    }

    await retry(async () => {
        const allResults = page.getByText(leadName, { exact: false });
        const target = allResults.nth(bestIdx);
        await target.waitFor({ state: 'visible', timeout: 15000 });
        log.info(`Clicking search result at index ${bestIdx}...`);
        await target.click();
        await page.waitForTimeout(2000);

        const url = page.url();
        if (url.includes('/dashboard') && !url.includes('/contacts/')) {
            const parentItem = page.locator('.search-item, .hl_contact-search-result, [class*="search-result"]').first();
            if (await parentItem.count() > 0) {
                await parentItem.click();
                await page.waitForTimeout(1500);
            } else {
                await page.keyboard.press('Enter');
                await page.waitForTimeout(1500);
            }
            if (page.url().includes('/dashboard') && !page.url().includes('/contacts/')) {
                throw new Error('Navigation did not happen after clicking search result');
            }
        }
    }, { attempts: 2, delayMs: 3000, label: 'click search result' });

    log.info('Lead page opened.');
    return true;
}

interface ScrollMetrics {
    ok: boolean;
    target: 'container' | 'window' | 'none';
    hint: string;
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    atBottom: boolean;
}

/**
 * Resolves the element that ACTUALLY scrolls the conversation, then acts on it.
 *
 * Everything runs in one page.evaluate so the resolver lives in a single place.
 * The chosen element is tagged with SCROLL_CONTAINER_ATTR so every later call
 * keeps scrolling the same element instead of re-guessing (and possibly picking
 * a different, non-scrollable wrapper) each time.
 *
 * modes: 'measure' = read position only, 'bottom' = jump to the end,
 *        'up' = step up roughly one viewport (used when hunting for the call).
 */
async function conversationScroll(page: Page, mode: 'measure' | 'bottom' | 'up'): Promise<ScrollMetrics> {
    return page.evaluate(({ mode, attr, tolerance }) => {
        const isScrollable = (el: Element): boolean => {
            const style = window.getComputedStyle(el);
            const oy = style.overflowY;
            if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') return false;
            return el.scrollHeight - el.clientHeight > 40;
        };

        const describe = (el: Element): string => {
            const id = el.id ? `#${el.id}` : '';
            const cls = (el.getAttribute('class') || '').trim().split(/\s+/).slice(0, 3).join('.');
            return `${el.tagName.toLowerCase()}${id}${cls ? '.' + cls : ''}`;
        };

        const resolve = (): HTMLElement | null => {
            // Reuse the element already tagged on a previous call, if still usable.
            const tagged = document.querySelector(`[${attr}="1"]`) as HTMLElement | null;
            if (tagged && tagged.isConnected && tagged.scrollHeight - tagged.clientHeight > 40) return tagged;
            if (tagged) tagged.removeAttribute(attr);

            const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
            const candidates: { el: HTMLElement; rect: DOMRect }[] = [];

            for (const el of Array.from(document.querySelectorAll<HTMLElement>('div, section, main, ul, ol'))) {
                if (!isScrollable(el)) continue;
                const rect = el.getBoundingClientRect();
                // Ignore narrow rails, collapsed panes and off-screen nodes.
                if (rect.width < 320 || rect.height < 200) continue;
                if (rect.bottom <= 0 || rect.top >= window.innerHeight) continue;
                candidates.push({ el, rect });
            }

            const scoreOf = (el: HTMLElement, rect: DOMRect): number => {
                const hay = `${el.getAttribute('class') || ''} ${el.id || ''}`;
                // Deliberately scored on size and content, NOT on how far the
                // element scrolls: the contacts rail often scrolls much further
                // than a short conversation and would otherwise win every time.
                let score = rect.width * rect.height;
                // A conversation/message list is what we want...
                if (/conversation|message|chat|thread|activity|timeline/i.test(hay)) score *= 8;
                // ...a sidebar, nav or search dropdown is what we keep mistaking it for.
                if (/sidebar|side-bar|nav|menu|dropdown|search|modal|tooltip/i.test(hay)) score *= 0.05;
                // Message-shaped children are the strongest signal of the real thread.
                const msgLike = el.querySelectorAll(
                    '[class*="message"], [class*="msg"], [class*="bubble"], [class*="activity"], [class*="event"]'
                ).length;
                score *= 1 + Math.min(msgLike, 40) / 4;
                return score;
            };

            const pick = (pool: { el: HTMLElement; rect: DOMRect }[]): HTMLElement | null => {
                let best: HTMLElement | null = null;
                let bestScore = -1;
                for (const { el, rect } of pool) {
                    const score = scoreOf(el, rect);
                    // Tie-break on scroll depth only when scores are equal.
                    if (score > bestScore || (score === bestScore && best &&
                        el.scrollHeight - el.clientHeight > best.scrollHeight - best.clientHeight)) {
                        bestScore = score;
                        best = el;
                    }
                }
                return best;
            };

            // Pass 1: the main content column only.
            const wide = candidates.filter(c => c.rect.width >= viewportWidth * 0.4);
            // Pass 2 relaxes the width gate for narrow layouts, but only for
            // elements that actually hold message-shaped children — otherwise a
            // short conversation makes us "scroll" the contacts rail instead.
            const narrowButMessagey = candidates.filter(c => c.el.querySelectorAll(
                '[class*="message"], [class*="msg"], [class*="bubble"], [class*="activity"], [class*="event"]'
            ).length >= 3);
            const pool = wide.length ? wide : narrowButMessagey;
            const best = pool.length ? pick(pool) : null;

            if (best) best.setAttribute(attr, '1');
            return best;
        };

        const el = resolve();

        if (el) {
            if (mode === 'bottom') {
                el.scrollTop = el.scrollHeight;
            } else if (mode === 'up') {
                el.scrollTop = Math.max(0, el.scrollTop - Math.round(el.clientHeight * 0.8));
            }
            return {
                ok: true,
                target: 'container' as const,
                hint: describe(el),
                scrollTop: el.scrollTop,
                scrollHeight: el.scrollHeight,
                clientHeight: el.clientHeight,
                atBottom: el.scrollHeight - el.scrollTop - el.clientHeight <= tolerance,
            };
        }

        // Fallback: the page itself is the scroller.
        const doc = document.scrollingElement || document.documentElement;
        const canScrollWindow = doc.scrollHeight - doc.clientHeight > 40;
        if (canScrollWindow) {
            if (mode === 'bottom') {
                window.scrollTo(0, doc.scrollHeight);
            } else if (mode === 'up') {
                window.scrollBy(0, -Math.round(doc.clientHeight * 0.8));
            }
            return {
                ok: true,
                target: 'window' as const,
                hint: 'window',
                scrollTop: doc.scrollTop,
                scrollHeight: doc.scrollHeight,
                clientHeight: doc.clientHeight,
                atBottom: doc.scrollHeight - doc.scrollTop - doc.clientHeight <= tolerance,
            };
        }

        return {
            ok: false,
            target: 'none' as const,
            hint: '',
            scrollTop: 0,
            scrollHeight: 0,
            clientHeight: 0,
            atBottom: false,
        };
    }, { mode, attr: SCROLL_CONTAINER_ATTR, tolerance: BOTTOM_TOLERANCE_PX });
}

/**
 * Nudges the conversation with real input events. GHL's message list is
 * virtualised and sometimes only fetches the next page on a genuine wheel /
 * keyboard event rather than on a programmatic scrollTop assignment.
 */
async function nudgeScroll(page: Page): Promise<void> {
    try {
        const box = await page.locator(`[${SCROLL_CONTAINER_ATTR}="1"]`).first().boundingBox({ timeout: 2000 });
        if (box) {
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.wheel(0, 4000);
            await page.waitForTimeout(250);
            await page.keyboard.press('End').catch(() => { /* focus may be elsewhere */ });
        }
    } catch { /* nudging is best-effort */ }
}

/**
 * Scrolls the conversation to the very end and keeps going until the thread
 * stops growing. Returns true only if we can prove we finished at the bottom.
 *
 * The thread grows while we scroll (lazy-loaded messages, images resizing,
 * incoming activity), so a single scrollTop = scrollHeight is not enough: it
 * lands at what was the bottom a moment ago. We therefore re-assert the bottom
 * until both the height and the position hold steady across several rounds.
 */
async function scrollConversationToBottom(page: Page, label = 'conversation'): Promise<boolean> {
    const deadline = Date.now() + (Actor.isAtHome() ? 45000 : 30000);
    let lastHeight = -1;
    let stableRounds = 0;
    let nudged = false;
    let metrics: ScrollMetrics | null = null;

    for (let round = 0; Date.now() < deadline; round++) {
        metrics = await conversationScroll(page, 'bottom');

        if (!metrics.ok) {
            // Nothing scrolls: the thread already fits on screen, so we are at its end.
            log.info(`${label} has no scrollable container — already showing the whole thread.`);
            return true;
        }

        if (metrics.atBottom && metrics.scrollHeight === lastHeight) {
            stableRounds++;
            // Three quiet rounds in a row: the thread has finished loading.
            if (stableRounds >= 3) {
                log.info(`Scrolled ${label} to bottom (${metrics.hint}, height ${metrics.scrollHeight}px, ${round + 1} rounds).`);
                return true;
            }
        } else {
            stableRounds = 0;
        }

        // Programmatic scrolling alone did not reach the end — use real input.
        if (!metrics.atBottom && round >= 5 && !nudged) {
            log.info(`${label} still not at bottom after ${round + 1} rounds — nudging with wheel/End.`);
            await nudgeScroll(page);
            nudged = true;
        }

        lastHeight = metrics.scrollHeight;
        await page.waitForTimeout(400);
    }

    const reached = metrics?.atBottom ?? false;
    const detail = `scrollTop=${metrics?.scrollTop}, scrollHeight=${metrics?.scrollHeight}`;
    if (reached) {
        // At the end, but the thread was still growing when time ran out.
        log.info(`Reached bottom of ${label} but it never settled (${detail}).`);
    } else {
        log.warning(`Timed out scrolling ${label} to bottom (${detail}).`);
    }
    return reached;
}

/**
 * Waits for the conversation to exist and returns its scroll container, if any.
 * Whether the thread SCROLLS is a separate question from whether it loaded: a
 * short conversation that fits on screen is perfectly valid.
 */
async function waitForConversation(page: Page, maxWait: number): Promise<{ present: boolean; container: ScrollMetrics | null }> {
    const panelSelectors = [
        '.conversation-panel',
        '[class*="conversation-panel"]',
        '.chat-content',
        '[class*="chat-content"]',
        '.conversation-body',
        '[class*="conversation"]',
    ];

    const deadline = Date.now() + maxWait;
    let panelPresent = false;
    let container: ScrollMetrics | null = null;

    while (Date.now() < deadline) {
        for (const sel of panelSelectors) {
            if (await page.locator(sel).count() > 0) {
                panelPresent = true;
                break;
            }
        }
        container = await conversationScroll(page, 'measure');
        if (panelPresent || container.ok) break;
        await page.waitForTimeout(1000);
    }

    return { present: panelPresent || !!container?.ok, container };
}

/**
 * Closes the activity sidebar to free up conversation space. Closing it reflows
 * the page, so the tagged scroll container is dropped and re-resolved against
 * the new layout.
 */
async function closeActivityPanel(page: Page): Promise<void> {
    try {
        const closeBtn = page.locator('#close-panel-button, #close-pannel-button');
        if (await closeBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
            await closeBtn.click();
            log.info('Activity panel closed.');
            await page.waitForTimeout(800);
        }
    } catch { /* panel may not exist */ }

    await page.evaluate((attr) => {
        document.querySelector(`[${attr}="1"]`)?.removeAttribute(attr);
    }, SCROLL_CONTAINER_ATTR);
    await conversationScroll(page, 'measure');
}

async function findCallCompleted(page: Page): Promise<CallInfo> {
    log.info('Waiting for conversation to load...');

    const { present, container } = await waitForConversation(page, Actor.isAtHome() ? 60000 : 15000);

    if (!present) {
        log.warning('No conversation panel found after waiting.');
        if (Actor.isAtHome()) {
            const store = await Actor.openKeyValueStore();
            await store.setValue('debug-no-panel', await page.screenshot({ type: 'jpeg', quality: 50 }), { contentType: 'image/jpeg' });
        }
        return { callFound: false, duration: null, durationSeconds: 0, meetsThreshold: false, screenshotUrl: null };
    }

    log.info(container?.ok
        ? `Conversation scroll container found: ${container.hint} (${container.target})`
        : 'Conversation panel found; it does not scroll (thread fits on screen).');

    await closeActivityPanel(page);

    // Land at the end of the thread first: the most recent call is the one we
    // report on, and the newest activity lives at the bottom.
    await scrollConversationToBottom(page);

    const callMatches = () => page.getByText('Call completed', { exact: false });
    let callCount = await callMatches().count();
    log.info(`"Call completed" in DOM: ${callCount}`);

    // Not at the bottom? Walk back up through the thread looking for one.
    if (callCount === 0) {
        log.info('No "Call completed" at bottom — scanning upwards...');
        for (let i = 0; i < 30; i++) {
            const m = await conversationScroll(page, 'up');
            await page.waitForTimeout(400);
            callCount = await callMatches().count();
            if (callCount > 0) {
                log.info(`Found "Call completed" after scrolling up ${i + 1} times.`);
                break;
            }
            if (m.scrollTop <= 0) {
                log.info('Reached top of conversation.');
                break;
            }
        }

        if (callCount === 0) {
            log.warning('No "Call completed" found after scrolling.');
            return { callFound: false, duration: null, durationSeconds: 0, meetsThreshold: false, screenshotUrl: null };
        }
    }

    // .last() is the most recent call: GHL threads run oldest-first, so .first()
    // would measure the oldest call in the conversation instead of this one.
    const callCompleted = callMatches().last();
    try {
        await callCompleted.scrollIntoViewIfNeeded({ timeout: 10000 });
    } catch {
        log.warning('scrollIntoView timed out, proceeding with extraction.');
    }
    await page.waitForTimeout(800);
    log.info(`"Call completed" visible in viewport (most recent of ${callCount}).`);

    // Extract duration from ancestor elements (audio player pattern: "0:00 / 5:23")
    let duration: string | null = null;
    let durationSeconds = 0;

    const ancestors = [
        callCompleted.locator('..'),
        callCompleted.locator('../..'),
        callCompleted.locator('../../..'),
        callCompleted.locator('../../../..'),
        callCompleted.locator('../../../../..'),
    ];

    for (const ancestor of ancestors) {
        if (duration) break;
        const text = await ancestor.textContent().catch(() => '') || '';
        const timeMatch = text.match(/(\d+:\d{2})\s*\/\s*(\d+:\d{2})/);
        if (timeMatch) {
            const parsed = parseDuration(timeMatch[2]);
            if (parsed) {
                duration = parsed.duration;
                durationSeconds = parsed.seconds;
                log.info(`Duration extracted: ${duration} (${durationSeconds}s)`);
            }
        }
    }

    if (!duration) {
        log.warning('Could not extract call duration from page.');
    }

    const meetsThreshold = durationSeconds >= DURATION_THRESHOLD_SECONDS;
    log.info(`Duration: ${duration || 'unknown'}, meets 5:00 threshold: ${meetsThreshold}`);

    let screenshotUrl: string | null = null;
    if (meetsThreshold) {
        log.info('Call meets threshold — taking screenshot...');
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                if (attempt > 0) await page.waitForTimeout(2000);

                // Re-assert the call entry's position immediately before each
                // attempt: the screenshot must show this call and its duration,
                // and late-arriving content can otherwise shift it out of frame.
                await callCompleted.scrollIntoViewIfNeeded({ timeout: 10000 })
                    .catch(() => log.warning('Could not re-confirm call position before capture.'));
                await page.waitForTimeout(500);

                const screenshot = await page.screenshot({ type: 'jpeg', quality: 75, timeout: 30000 });
                const store = await Actor.openKeyValueStore();
                await store.setValue('call-screenshot', screenshot, { contentType: 'image/jpeg' });
                screenshotUrl = `https://api.apify.com/v2/key-value-stores/${store.id}/records/call-screenshot`;
                log.info(`Screenshot saved: ${screenshotUrl}`);
                break;
            } catch (err: any) {
                log.warning(`Screenshot attempt ${attempt + 1} failed: ${err.message}`);
                if (err.message.includes('closed') || err.message.includes('crashed')) break;
            }
        }
    }

    return { callFound: true, duration, durationSeconds, meetsThreshold, screenshotUrl };
}

// --- Main execution ---
await Actor.init();

const input = await Actor.getInput<ActorInput>();

if (input?.loginMode) {
    await runLoginMode();
    await Actor.exit();
}

if (!input?.subAccountUrl || !input?.leadName) {
    throw new Error('Input must contain "subAccountUrl" and "leadName"');
}

log.info('Starting Unscheduled Call Complete automation', {
    url: input.subAccountUrl,
    leadName: input.leadName,
});

const { context, persistent } = await getContext(input);

try {
    const page = persistent ? context.pages()[0] || await context.newPage() : await context.newPage();

    log.info('Navigating to sub-account...');
    await page.goto(input.subAccountUrl, { waitUntil: 'load', timeout: 120000 });

    // Detect login/logout vs. dashboard by polling both outcomes instead of a
    // single 5s check followed by a blind 90s x 2 dashboard wait. GHL's dead-
    // session redirect is a CLIENT-SIDE navigation that fires after this page's
    // own "load" event, and it can land on a URL like "/?logout=true" — logout
    // as a query param, not a "/logout" path segment — so a single point-in-time
    // check plus a narrow URL substring match both used to miss it and fall
    // through into wasted minutes of timeouts. Polling with short, independent
    // isVisible() checks (instead of one long-lived waitForSelector) also
    // survives that mid-flight client-side redirect without erroring out.
    const dashboardSelector = '#globalSearchOpener';
    const loginSelector = 'input[type="email"], input[type="password"], button:has-text("Login"), button:has-text("Sign in")';
    const loggedOutUrl = (url: string) => /[/?&](login|logout|oauth)(\/|$|[=&?])/.test(url);

    async function detectAuthState(maxWaitMs: number): Promise<'dashboard' | 'login' | 'unknown'> {
        const deadline = Date.now() + maxWaitMs;
        while (Date.now() < deadline) {
            const [hasDashboard, hasLogin] = await Promise.all([
                page.locator(dashboardSelector).first().isVisible().catch(() => false),
                page.locator(loginSelector).first().isVisible().catch(() => false),
            ]);
            if (hasDashboard) return 'dashboard';
            if (hasLogin) return 'login';
            await page.waitForTimeout(500).catch(() => { /* page may be mid-navigation */ });
        }
        return loggedOutUrl(page.url()) ? 'login' : 'unknown';
    }

    const authState = await detectAuthState(20000);

    if (authState === 'login') {
        log.warning(`Session expired — login/logout detected (url: ${page.url()}).`);
        const loginError = 'LOGIN_REQUIRED: Cookies expired. Run locally with loginMode=true to refresh storage-state.json';
        if (input.screenshotOnly) {
            await Actor.pushData({ screenshotUrl: null, format: 'jpeg', sizeBytes: 0, error: loginError });
        } else {
            await Actor.pushData({
                leadFound: false,
                leadName: input.leadName,
                callFound: false,
                duration: null,
                durationSeconds: 0,
                meetsThreshold: false,
                screenshotUrl: null,
                error: loginError,
            });
        }
        await context.close();
        await Actor.exit();
    }

    if (authState === 'dashboard') {
        log.info('Dashboard loaded.');
    } else {
        // Genuinely ambiguous after 20s of polling — fall back to the longer
        // retried wait as a safety net rather than guessing either way.
        log.info('Auth state unclear after 20s — falling back to dashboard wait/retry.');
        await retry(async () => {
            await page.waitForSelector(dashboardSelector, { state: 'visible', timeout: 90000 });
        }, { attempts: 2, delayMs: 5000, label: 'wait for dashboard' });
        log.info('Dashboard loaded.');
    }

    const leadFound = await searchAndClickLead(page, input.leadName);

    const output: ActorOutput = {
        leadFound,
        leadName: input.leadName,
        callFound: false,
        duration: null,
        durationSeconds: 0,
        meetsThreshold: false,
        screenshotUrl: null,
        error: null,
    };

    if (!leadFound) {
        if (input.screenshotOnly) {
            await Actor.pushData({ screenshotUrl: null, format: 'jpeg', sizeBytes: 0, error: `Lead "${input.leadName}" not found in search.` });
        } else {
            output.error = `Lead "${input.leadName}" not found in search.`;
            log.info(output.error);
            await Actor.pushData(output);
        }
    } else if (input.screenshotOnly) {
        log.info('Screenshot-only mode: capturing conversation...');

        const { present, container } = await waitForConversation(page, Actor.isAtHome() ? 60000 : 15000);
        if (!present) {
            log.warning('No conversation panel found after waiting.');
        } else {
            log.info(container?.ok
                ? `Conversation scroll container found: ${container.hint} (${container.target})`
                : 'Conversation panel found; it does not scroll (thread fits on screen).');
        }

        await closeActivityPanel(page);

        // Capture the end of the thread, where the most recent messages are.
        await scrollConversationToBottom(page);
        await page.waitForTimeout(500);

        let screenshotUrl: string | null = null;
        let sizeBytes = 0;
        try {
            const screenshot = await page.screenshot({ type: 'jpeg', quality: 75, timeout: 30000 });
            sizeBytes = screenshot.length;
            const store = await Actor.openKeyValueStore();
            await store.setValue('conversation-screenshot', screenshot, { contentType: 'image/jpeg' });
            screenshotUrl = `https://api.apify.com/v2/key-value-stores/${store.id}/records/conversation-screenshot`;
            log.info(`Screenshot saved: ${screenshotUrl} (${sizeBytes} bytes)`);
        } catch (err: any) {
            log.warning(`Screenshot failed: ${err.message}`);
        }

        await Actor.pushData({ screenshotUrl, format: 'jpeg', sizeBytes, error: screenshotUrl ? null : 'Screenshot capture failed' });
    } else {
        log.info('Phase 1 complete: Lead found and opened.');

        const callResult = await findCallCompleted(page);
        output.callFound = callResult.callFound;
        output.duration = callResult.duration;
        output.durationSeconds = callResult.durationSeconds;
        output.meetsThreshold = callResult.meetsThreshold;
        output.screenshotUrl = callResult.screenshotUrl;

        if (!callResult.callFound) {
            output.error = 'No "Call completed" entry found for this lead.';
            log.info(output.error);
        } else {
            log.info(`Result — duration: ${output.duration}, meets threshold: ${output.meetsThreshold}`);
        }
        await Actor.pushData(output);
    }
} finally {
    await context.close();
}

await Actor.exit();
