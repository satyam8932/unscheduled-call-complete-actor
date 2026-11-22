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
    alwaysScreenshot?: boolean;
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
    // Only set on the fallback result: the page URL the fallback picture shows.
    pageUrl?: string;
}

interface ScreenshotOnlyOutput {
    screenshotUrl: string | null;
    format: 'jpeg';
    sizeBytes: number;
    error: string | null;
    pageUrl?: string;
}

const LOCAL_STORAGE_STATE = resolve(process.cwd(), 'storage-state.json');
const CDP_ENDPOINT = 'http://127.0.0.1:9222';
const DURATION_THRESHOLD_SECONDS = 300;
const SCROLL_CONTAINER_ATTR = 'data-call-scroll-container';
const BOTTOM_TOLERANCE_PX = 8;

async function retry<T>(fn: () => Promise<T>, { attempts = 3, delayMs = 1000, label = 'operation' } = {}): Promise<T> {
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (err: any) {
            if (i === attempts - 1) throw err;
            log.warning(`${label} failed (attempt ${i + 1}/${attempts}): ${err.message}. Retrying in ${delayMs}ms...`);
            await new Promise((r) => setTimeout(r, delayMs));
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
            log.warning(
                'CDP connection failed. Start Chromium with --remote-debugging-port=9222, or use storage-state.json / loginMode=true instead.',
            );
        }

        if (existsSync(LOCAL_STORAGE_STATE)) {
            // HEADLESS=false shows the browser, to watch a local run.
            const headless = process.env.HEADLESS !== 'false';
            log.info(`Using local storage-state.json (${headless ? 'headless' : 'headed'}, bundled Chromium)`);
            const browser = await chromium.launch({
                headless,
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
    await page.waitForURL(
        (url) => {
            const path = new URL(url).pathname;
            return path.includes('/dashboard') || path.includes('/v2/location') || path.includes('/agency_dashboard');
        },
        { timeout: 300000 },
    );

    const state = await context.storageState();
    writeFileSync(LOCAL_STORAGE_STATE, JSON.stringify(state, null, 2));
    log.info(`Storage state saved to ${LOCAL_STORAGE_STATE}`);

    await browser.close();
    log.info('Login mode complete.');
}

// GHL global search v2 ("gs2"): one popup that mixes every category, with a
// row of category pills (All, Contacts, Opportunities, ...) above the results.
const SEARCH_OPENER = '#globalSearchOpener';
const SEARCH_INPUT = 'input[role="combobox"][aria-controls^="gs2-panel"], #global-search-input';
const SEARCH_BODY = '.gs2-body[role="region"], [id^="gs2-panel-"][role="region"]';
const SEARCH_PILL = 'button.gs2-apps-pill[role="tab"]';
const RESULT_ROW = '[role="option"]';
const RESULT_TITLE = '.v2-result-row__title-text, .v2-result-row__title';
const SEARCH_NO_RESULTS = '.gs2-no-results__header-text, .gs2-no-results__section-label';

const normalizeName = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

async function openGlobalSearch(page: Page): Promise<void> {
    const input = page.locator(SEARCH_INPUT).first();
    if (await input.isVisible().catch(() => false)) return;

    await retry(
        async () => {
            log.info('Opening global search...');
            const opener = page.locator(SEARCH_OPENER).first();
            if (await opener.isVisible().catch(() => false)) {
                await opener.click();
            } else {
                // The popup also opens with the Cmd/Ctrl+K shortcut.
                await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
            }
            await input.waitFor({ state: 'visible', timeout: 15000 });
        },
        { attempts: 3, delayMs: 2000, label: 'open search popup' },
    );
}

/**
 * Reads the visible result rows once they stop changing. The popup re-renders
 * while the query debounces and again after a pill is clicked, so a single
 * read can catch results for a half-typed name or the previous tab.
 * Contact rows are preferred: in the "All" tab they sit in a group labelled
 * "Contacts", and after the Contacts pill is selected they are the only rows.
 */
async function readStableResults(page: Page, timeoutMs = 15000): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    let stableRounds = 0;
    let snapshot = { noResults: false, titles: [] as string[] };

    while (Date.now() < deadline) {
        snapshot = await page
            .evaluate(
                ({ bodySel, rowSel, titleSel, noResultsSel }) => {
                    // Inline callbacks only: tsx wraps named functions in a __name()
                    // helper that does not exist inside the browser.
                    const body = Array.from(document.querySelectorAll(bodySel)).find(
                        (el) => (el as HTMLElement).offsetParent !== null,
                    );
                    if (!body) return { noResults: false, titles: [] as string[] };
                    // "No results" still renders "Ask AI" / "Add Contact" rows, so it
                    // has to be checked before the rows are read.
                    const empty = body.querySelector(noResultsSel) as HTMLElement | null;
                    if (empty && empty.offsetParent !== null) return { noResults: true, titles: [] as string[] };
                    const scope = body.querySelector('[role="group"][aria-label="Contacts" i]') || body;
                    const titles = Array.from(scope.querySelectorAll(rowSel))
                        .filter((el) => (el as HTMLElement).offsetParent !== null)
                        .map((row) => ((row.querySelector(titleSel) as HTMLElement | null)?.innerText || '').trim());
                    return { noResults: false, titles };
                },
                { bodySel: SEARCH_BODY, rowSel: RESULT_ROW, titleSel: RESULT_TITLE, noResultsSel: SEARCH_NO_RESULTS },
            )
            // A re-render mid-read can destroy the evaluate context; keep the last snapshot and poll again.
            .catch(() => snapshot);

        const key = JSON.stringify(snapshot);
        if (key === last) {
            stableRounds++;
            // The empty state can flash while the query debounces, so it must
            // hold for a few rounds before it counts as "lead not found".
            if (snapshot.noResults && stableRounds >= 3) {
                log.info('Search shows "No results".');
                return [];
            }
            if (stableRounds >= 2 && (snapshot.titles.length > 0 || stableRounds >= 6)) return snapshot.titles;
        } else {
            stableRounds = 0;
            last = key;
        }
        await page.waitForTimeout(500);
    }
    return snapshot.titles;
}

/** Same scoping as readStableResults, as a locator so rows can be clicked. */
async function resultRows(page: Page) {
    const body = page.locator(SEARCH_BODY).filter({ visible: true }).first();
    const group = body.locator('[role="group"][aria-label="Contacts" i]').first();
    const scope = (await group.count()) > 0 ? group : body;
    return scope.locator(RESULT_ROW).filter({ visible: true });
}

async function selectContactsPill(page: Page): Promise<boolean> {
    const pill = page
        .locator(SEARCH_PILL)
        .filter({ has: page.locator('.gs2-apps-pill__label', { hasText: /^\s*Contacts\s*$/i }) })
        .first();
    try {
        await pill.waitFor({ state: 'visible', timeout: 10000 });
        if ((await pill.getAttribute('aria-selected')) !== 'true') {
            log.info('Selecting "Contacts" pill...');
            await pill.click();
        }
        await page.waitForFunction((el) => el?.getAttribute('aria-selected') === 'true', await pill.elementHandle(), {
            timeout: 5000,
        });
        return true;
    } catch (err: any) {
        log.warning(`Could not select Contacts pill (${err.message}) — falling back to the Contacts group in "All".`);
        return false;
    }
}

/**
 * Picks the row to open: an exact name match first, then the top-most row that
 * contains the full name, then the top-most row that contains every word of it.
 * Rows ending in a "(2)"-style duplicate marker are skipped unless nothing else
 * matches. Returns -1 when no row matches the lead at all.
 */
function pickBestResult(titles: string[], leadName: string): number {
    const target = normalizeName(leadName);
    const words = target.split(' ');
    const isDuplicate = (t: string) => /\(\d+\)/.test(t);

    const exact = titles.findIndex((t) => normalizeName(t) === target);
    if (exact !== -1) return exact;

    const tiers = [
        (t: string) => normalizeName(t).includes(target),
        (t: string) => words.every((w) => normalizeName(t).split(' ').includes(w)),
    ];
    for (const matches of tiers) {
        const clean = titles.findIndex((t) => matches(t) && !isDuplicate(t));
        if (clean !== -1) return clean;
        const any = titles.findIndex((t) => matches(t));
        if (any !== -1) return any;
    }
    return -1;
}

async function searchAndClickLead(page: Page, leadName: string): Promise<boolean> {
    await page.waitForTimeout(1000);
    await openGlobalSearch(page);

    log.info('Search popup visible, typing lead name...');
    const input = page.locator(SEARCH_INPUT).first();
    await input.click();
    await input.fill('');
    await page.keyboard.type(leadName, { delay: 30 });

    log.info('Waiting for search results...');
    await page.waitForTimeout(1500);
    const pillSelected = await selectContactsPill(page);

    const titles = await readStableResults(page);
    titles.forEach((t, i) => log.info(`Search result [${i}]: "${t.substring(0, 60)}"`));

    if (titles.length === 0) {
        const note = pillSelected ? '' : ' (Contacts pill not selected)';
        log.warning(`Lead not found: "${leadName}" — no contact results${note}.`);
        return false;
    }

    const bestIdx = pickBestResult(titles, leadName);
    if (bestIdx === -1) {
        log.warning(`Lead not found: "${leadName}" — no contact result matches the name.`);
        return false;
    }
    log.info(`Best match at index ${bestIdx}: "${titles[bestIdx]}"`);

    const startUrl = page.url();
    await retry(
        async () => {
            const row = (await resultRows(page)).nth(bestIdx);
            await row.waitFor({ state: 'visible', timeout: 15000 });
            const rowTitle = (
                await row
                    .locator(RESULT_TITLE)
                    .first()
                    .innerText()
                    .catch(() => '')
            ).trim();
            if (normalizeName(rowTitle) !== normalizeName(titles[bestIdx])) {
                throw new Error(`Result list changed before click (expected "${titles[bestIdx]}", saw "${rowTitle}")`);
            }

            log.info(`Clicking search result at index ${bestIdx}...`);
            // Click the name, not the row's "Open in new tab" / "Copy URL" buttons.
            await row.locator(RESULT_TITLE).first().click();
            const navigated = await page
                .waitForURL((url) => url.toString() !== startUrl, { timeout: 8000 })
                .then(
                    () => true,
                    () => false,
                );

            if (!navigated) {
                // Clicking marks the row as highlighted; Enter opens the highlighted row.
                log.info('No navigation after click — pressing Enter on the highlighted row...');
                await row.hover();
                await page.keyboard.press('Enter');
                await page.waitForURL((url) => url.toString() !== startUrl, { timeout: 8000 });
            }
            await page.waitForTimeout(2000);
        },
        { attempts: 2, delayMs: 3000, label: 'click search result' },
    );

    log.info(`Lead page opened: ${page.url()}`);
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
    return page.evaluate(
        ({ mode, attr, tolerance }) => {
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
                        '[class*="message"], [class*="msg"], [class*="bubble"], [class*="activity"], [class*="event"]',
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
                        if (
                            score > bestScore ||
                            (score === bestScore &&
                                best &&
                                el.scrollHeight - el.clientHeight > best.scrollHeight - best.clientHeight)
                        ) {
                            bestScore = score;
                            best = el;
                        }
                    }
                    return best;
                };

                // Pass 1: the main content column only.
                const wide = candidates.filter((c) => c.rect.width >= viewportWidth * 0.4);
                // Pass 2 relaxes the width gate for narrow layouts, but only for
                // elements that actually hold message-shaped children — otherwise a
                // short conversation makes us "scroll" the contacts rail instead.
                const narrowButMessagey = candidates.filter(
                    (c) =>
                        c.el.querySelectorAll(
                            '[class*="message"], [class*="msg"], [class*="bubble"], [class*="activity"], [class*="event"]',
                        ).length >= 3,
                );
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
        },
        { mode, attr: SCROLL_CONTAINER_ATTR, tolerance: BOTTOM_TOLERANCE_PX },
    );
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
            await page.keyboard.press('End').catch(() => {
                /* focus may be elsewhere */
            });
        }
    } catch {
        /* nudging is best-effort */
    }
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
                log.info(
                    `Scrolled ${label} to bottom (${metrics.hint}, height ${metrics.scrollHeight}px, ${round + 1} rounds).`,
                );
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
async function waitForConversation(
    page: Page,
    maxWait: number,
): Promise<{ present: boolean; container: ScrollMetrics | null }> {
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
            if ((await page.locator(sel).count()) > 0) {
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
    } catch {
        /* panel may not exist */
    }

    await page.evaluate((attr) => {
        document.querySelector(`[${attr}="1"]`)?.removeAttribute(attr);
    }, SCROLL_CONTAINER_ATTR);
    await conversationScroll(page, 'measure');
}

async function findCallCompleted(page: Page, alwaysScreenshot = false): Promise<CallInfo> {
    log.info('Waiting for conversation to load...');

    const { present, container } = await waitForConversation(page, Actor.isAtHome() ? 60000 : 15000);

    if (!present) {
        log.warning('No conversation panel found after waiting.');
        if (Actor.isAtHome()) {
            const store = await Actor.openKeyValueStore();
            await store.setValue('debug-no-panel', await page.screenshot({ type: 'jpeg', quality: 50 }), {
                contentType: 'image/jpeg',
            });
        }
        return { callFound: false, duration: null, durationSeconds: 0, meetsThreshold: false, screenshotUrl: null };
    }

    log.info(
        container?.ok
            ? `Conversation scroll container found: ${container.hint} (${container.target})`
            : 'Conversation panel found; it does not scroll (thread fits on screen).',
    );

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
        const text = (await ancestor.textContent().catch(() => '')) || '';
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
    if (meetsThreshold || alwaysScreenshot) {
        log.info(
            meetsThreshold
                ? 'Call meets threshold, taking screenshot...'
                : 'alwaysScreenshot is on, taking screenshot of a call under the threshold...',
        );
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                if (attempt > 0) await page.waitForTimeout(2000);

                // Re-assert the call entry's position immediately before each
                // attempt: the screenshot must show this call and its duration,
                // and late-arriving content can otherwise shift it out of frame.
                await callCompleted
                    .scrollIntoViewIfNeeded({ timeout: 10000 })
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

// The n8n workflow stops waiting at 330s. Past this point a second full attempt
// would not finish in time, so go straight to the fallback picture instead.
const RETRY_DEADLINE_MS = 230000;
const MAX_ATTEMPTS = 2;
const DASHBOARD_NOT_LOADED_ERROR =
    'DASHBOARD_NOT_LOADED: the GHL dashboard did not load after a full page reload, so this is a picture of what the page showed instead.';

type RunResult = ActorOutput | ScreenshotOnlyOutput;

interface AttemptProgress {
    dashboardLoaded: boolean;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

function safePageUrl(page: Page | null): string | null {
    try {
        return page ? page.url() : null;
    } catch {
        return null;
    }
}

// Chrome on a fresh Apify container sometimes sees the network change during
// the first page load: goto fails with net::ERR_NETWORK_CHANGED, then Chrome's
// own error page auto-reloads and interrupts the next goto. That is a short
// blip, not GHL failing, so retry the load a few times before giving up.
const TRANSIENT_NAV_ERROR = /net::ERR_NETWORK_CHANGED|interrupted by another navigation/;

async function loadSubAccount(page: Page, url: string): Promise<void> {
    const maxTries = 3;
    for (let tryNo = 1; ; tryNo++) {
        try {
            await page.goto(url, { waitUntil: 'load', timeout: 120000 });
            return;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (!TRANSIENT_NAV_ERROR.test(message) || tryNo >= maxTries) throw err;
            log.warning(`Page load hit a network blip (${message.split('\n')[0]}). Retrying in 3s (${tryNo}/${maxTries - 1})...`);
            await page.waitForTimeout(3000).catch(() => {
                /* page may be mid-navigation */
            });
        }
    }
}

// One full pass: load the sub-account, check auth, wait for the dashboard, find
// the lead, then the call and its screenshot. Returns the output instead of
// pushing it. Throws when something breaks, so the caller can reload and retry.
async function runAttempt(
    page: Page,
    input: ActorInput,
    attemptNo: number,
    progress: AttemptProgress,
): Promise<RunResult> {
    log.info(
        attemptNo === 1
            ? 'Navigating to sub-account...'
            : `Attempt ${attemptNo}: reloading the sub-account page from scratch...`,
    );
    await loadSubAccount(page, input.subAccountUrl);

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
    const loginSelector =
        'input[type="email"], input[type="password"], button:has-text("Login"), button:has-text("Sign in")';
    const loggedOutUrl = (url: string) => /[/?&](login|logout|oauth)(\/|$|[=&?])/.test(url);

    async function detectAuthState(maxWaitMs: number): Promise<'dashboard' | 'login' | 'unknown'> {
        const deadline = Date.now() + maxWaitMs;
        while (Date.now() < deadline) {
            const [hasDashboard, hasLogin] = await Promise.all([
                page
                    .locator(dashboardSelector)
                    .first()
                    .isVisible()
                    .catch(() => false),
                page
                    .locator(loginSelector)
                    .first()
                    .isVisible()
                    .catch(() => false),
            ]);
            if (hasDashboard) return 'dashboard';
            if (hasLogin) return 'login';
            await page.waitForTimeout(500).catch(() => {
                /* page may be mid-navigation */
            });
        }
        return loggedOutUrl(page.url()) ? 'login' : 'unknown';
    }

    const authState = await detectAuthState(20000);

    if (authState === 'login') {
        log.warning(`Session expired — login/logout detected (url: ${page.url()}).`);
        const loginError =
            'LOGIN_REQUIRED: Cookies expired. Run locally with loginMode=true to refresh storage-state.json';
        if (input.screenshotOnly) {
            return { screenshotUrl: null, format: 'jpeg', sizeBytes: 0, error: loginError };
        }
        return {
            leadFound: false,
            leadName: input.leadName,
            callFound: false,
            duration: null,
            durationSeconds: 0,
            meetsThreshold: false,
            screenshotUrl: null,
            error: loginError,
        };
    }

    if (authState === 'dashboard') {
        log.info('Dashboard loaded.');
    } else {
        // Genuinely ambiguous after 20s of polling — give the dashboard one more
        // bounded wait. If it still isn't there, the caller reloads the page.
        log.info('Auth state unclear after 20s — waiting up to 45s more for the dashboard.');
        const visible = await page
            .waitForSelector(dashboardSelector, { state: 'visible', timeout: 45000 })
            .then(
                () => true,
                () => false,
            );
        if (!visible) {
            throw new Error(`DASHBOARD_NOT_LOADED: ${dashboardSelector} was not visible after 65s (url: ${page.url()})`);
        }
        log.info('Dashboard loaded.');
    }
    progress.dashboardLoaded = true;

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
            return {
                screenshotUrl: null,
                format: 'jpeg',
                sizeBytes: 0,
                error: `Lead "${input.leadName}" not found in search.`,
            };
        }
        output.error = `Lead "${input.leadName}" not found in search.`;
        log.info(output.error);
        return output;
    }

    if (input.screenshotOnly) {
        log.info('Screenshot-only mode: capturing conversation...');

        const { present, container } = await waitForConversation(page, Actor.isAtHome() ? 60000 : 15000);
        if (!present) {
            log.warning('No conversation panel found after waiting.');
        } else {
            log.info(
                container?.ok
                    ? `Conversation scroll container found: ${container.hint} (${container.target})`
                    : 'Conversation panel found; it does not scroll (thread fits on screen).',
            );
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

        return {
            screenshotUrl,
            format: 'jpeg',
            sizeBytes,
            error: screenshotUrl ? null : 'Screenshot capture failed',
        };
    }

    log.info('Phase 1 complete: Lead found and opened.');

    const callResult = await findCallCompleted(page, input.alwaysScreenshot === true);
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
    return output;
}

// Picture of whatever the page shows right now. Never throws.
async function captureFallbackScreenshot(page: Page | null): Promise<{ url: string | null; sizeBytes: number }> {
    try {
        if (!page || page.isClosed()) {
            log.warning('No open page to capture for the fallback picture.');
            return { url: null, sizeBytes: 0 };
        }
        const screenshot = await page.screenshot({ type: 'jpeg', quality: 75, timeout: 30000 });
        const store = await Actor.openKeyValueStore();
        await store.setValue('page-fallback', screenshot, { contentType: 'image/jpeg' });
        const url = `https://api.apify.com/v2/key-value-stores/${store.id}/records/page-fallback`;
        log.info(`Fallback screenshot saved: ${url}`);
        return { url, sizeBytes: screenshot.length };
    } catch (err) {
        log.warning(`Fallback screenshot failed: ${errorMessage(err)}`);
        return { url: null, sizeBytes: 0 };
    }
}

// Result for a run that could not finish normally: same output shape, with a
// picture of the page instead of the call screenshot. Never throws.
async function buildFallbackResult(page: Page | null, input: ActorInput | null, error: string): Promise<RunResult> {
    const shot = await captureFallbackScreenshot(page);
    const pageUrl = safePageUrl(page) ?? undefined;
    if (input?.screenshotOnly) {
        return { screenshotUrl: shot.url, format: 'jpeg', sizeBytes: shot.sizeBytes, pageUrl, error };
    }
    return {
        leadFound: false,
        leadName: input?.leadName ?? '',
        callFound: false,
        duration: null,
        durationSeconds: 0,
        meetsThreshold: false,
        screenshotUrl: shot.url,
        pageUrl,
        error,
    };
}

await Actor.init();
const runStartedAt = Date.now();

const input = await Actor.getInput<ActorInput>();

if (input?.loginMode) {
    await runLoginMode();
    await Actor.exit();
}

let context: BrowserContext | null = null;
let page: Page | null = null;
let result: RunResult | null = null;

// Nothing may escape this block: Apify restarts runs that exit non-zero, and
// the n8n workflow then only sees "crashed". Always push exactly one dataset
// item, always close the browser, always exit 0.
try {
    if (!input?.subAccountUrl || !input?.leadName) {
        throw new Error('Input must contain "subAccountUrl" and "leadName"');
    }

    log.info('Starting Unscheduled Call Complete automation', {
        url: input.subAccountUrl,
        leadName: input.leadName,
    });

    const browser = await getContext(input);
    context = browser.context;
    // Local dev runs through tsx, which wraps named functions in a __name() helper.
    // Code passed to page.evaluate() carries those calls into the browser, where the
    // helper is missing, so provide a no-op there.
    await context.addInitScript('globalThis.__name = globalThis.__name || ((fn) => fn);');

    page = browser.persistent ? context.pages()[0] || (await context.newPage()) : await context.newPage();

    let lastError: unknown = null;
    let dashboardLoaded = false;

    for (let attemptNo = 1; attemptNo <= MAX_ATTEMPTS; attemptNo++) {
        if (attemptNo > 1) {
            const elapsedSecs = Math.round((Date.now() - runStartedAt) / 1000);
            if (Date.now() - runStartedAt > RETRY_DEADLINE_MS) {
                log.warning(
                    `${elapsedSecs}s elapsed (limit ${RETRY_DEADLINE_MS / 1000}s): skipping attempt ${attemptNo} and returning a picture of the page instead.`,
                );
                break;
            }
            if (page.isClosed()) page = await context.newPage();
            // Give the network and any Chrome error page a moment to settle.
            await page.waitForTimeout(3000).catch(() => {
                /* page may be mid-navigation */
            });
        }

        const progress: AttemptProgress = { dashboardLoaded: false };
        try {
            result = await runAttempt(page, input, attemptNo, progress);
            break;
        } catch (err) {
            lastError = err;
            dashboardLoaded = progress.dashboardLoaded;
            const pageTitle = await page.title().catch(() => '(unavailable)');
            log.error(`Attempt ${attemptNo}/${MAX_ATTEMPTS} failed: ${errorMessage(err)}`, {
                pageUrl: safePageUrl(page),
                pageTitle,
            });
        }
    }

    if (!result) {
        result = await buildFallbackResult(
            page,
            input,
            dashboardLoaded ? `ACTOR_ERROR: ${errorMessage(lastError)}` : DASHBOARD_NOT_LOADED_ERROR,
        );
    }
} catch (err) {
    // Setup failed (bad input, no browser or session) or something escaped above.
    log.error(`Run failed: ${errorMessage(err)}`);
    result = await buildFallbackResult(page, input ?? null, `ACTOR_ERROR: ${errorMessage(err)}`);
} finally {
    try {
        await Actor.pushData(
            result ??
                ({
                    leadFound: false,
                    leadName: input?.leadName ?? '',
                    callFound: false,
                    duration: null,
                    durationSeconds: 0,
                    meetsThreshold: false,
                    screenshotUrl: null,
                    error: 'ACTOR_ERROR: run ended without a result',
                } satisfies ActorOutput),
        );
    } catch (err) {
        log.error(`Could not push the result to the dataset: ${errorMessage(err)}`);
    }
    await context?.close().catch((err: unknown) => log.warning(`Closing the browser failed: ${errorMessage(err)}`));
}

await Actor.exit();
