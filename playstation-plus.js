import { firefox } from "playwright-firefox"; // stealth plugin needs no outdated playwright-extra
import { authenticator } from "otplib";
import {
    datetime,
    handleSIGINT,
    html_game_list,
    jsonDb,
    notify,
    prompt,
} from "./util.js";
import path from "path";
import { existsSync, writeFileSync } from "fs";
import { cfg } from "./config.js";

// ### SETUP
const URL_CLAIM = "https://www.playstation.com/en-us/ps-plus/whats-new";

console.log(datetime(), "started checking playstation plus");

const db = await jsonDb("playstation-plus.json");
db.data ||= {};

handleSIGINT();

// https://playwright.dev/docs/auth#multi-factor-authentication
const context = await firefox.launchPersistentContext(cfg.dir.browser, {
    headless: cfg.headless,
    viewport: { width: cfg.width, height: cfg.height },
    locale: "en-US", // ignore OS locale to be sure to have english text for locators -> done via /en in URL
});

if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);

const page = context.pages().length
    ? context.pages()[0]
    : await context.newPage(); // should always exist
// console.debug('userAgent:', await page.evaluate(() => navigator.userAgent));

const notify_games = [];
let user;

try {
    await performLogin();
    await getAndSaveUser();
    await redeemFreeGames();
} catch (error) {
    console.error(error); // .toString()?
    process.exitCode ||= 1;
    if (error.message && process.exitCode != 130)
        notify(`playstation-plus failed: ${error.message.split("\n")[0]}`);
} finally {
    await db.write(); // write out json db
    if (notify_games.filter((g) => g.status != "existed").length) {
        // don't notify if all were already claimed
        notify(
            `playstation-plus (${user}):<br>${html_game_list(notify_games)}`
        );
    }
}
await context.close();

async function performLogin() {
    // TODO figure out cookies
    // await context.addCookies([{name: 'CookieConsent', value: '{stamp:%274oR8MJL+bxVlG6g+kl2we5+suMJ+Tv7I4C5d4k+YY4vrnhCD+P23RQ==%27%2Cnecessary:true%2Cpreferences:true%2Cstatistics:true%2Cmarketing:true%2Cmethod:%27explicit%27%2Cver:1%2Cutc:1672331618201%2Cregion:%27de%27}', domain: 'www.gog.com', path: '/'}]); // to not waste screen space when non-headless

    await page.goto(URL_CLAIM, { waitUntil: "domcontentloaded" }); // default 'load' takes forever

    // SELECTORS
    const signIn = page.locator('span:has-text("Sign in")').first();
    const profileIcon = page.locator(".profile-icon").first();

    const mainPageBaseUrl = "https://playstation.com";
    const loginPageBaseUrl = "https://my.account.sony.com";

    // const mainPageUrlCheck = page.waitForURL(`**${mainPageUrlSnippet}**`, { waitUntil: 'domcontentloaded'});
    // const loginPageUrlCheck = page.waitForURL(`**${loginPageUrlSnippet}**`, { waitUntil: 'domcontentloaded'});

    async function isSignedIn() {
        await Promise.any([signIn.waitFor(), profileIcon.waitFor()]);
        return !(await signIn.isVisible());
    }

    if (!(await isSignedIn())) {
        await signIn.click();

        page.waitForLoadState("domcontentloaded");

        // await Promise.any([mainPageUrlCheck, loginPageUrlCheck]);

        if (page.url().indexOf(mainPageBaseUrl) === 0) {
            if (await isSignedIn()) {
                return; // logged in using saved cookie
            } else {
                // stuck in login loop?
            }
        } else if (page.url().indexOf(loginPageBaseUrl) === 0) {
            console.error("Not signed in anymore.");
            await signInToPSN();
        } else {
            // lost! where am i?
        }
    }
}

async function signInToPSN() {
    // it then creates an iframe for the login
    await page.waitForSelector("#kekka-main");
    if (!cfg.debug) context.setDefaultTimeout(cfg.login_timeout); // give user some extra time to log in
    console.info(`Login timeout is ${cfg.login_timeout / 1000} seconds!`);

    // ### FETCH EMAIL/PASS
    if (cfg.psp_email && cfg.psp_password)
        console.info("Using email and password from environment.");
    else
        console.info(
            "Press ESC to skip the prompts if you want to login in the browser (not possible in headless mode)."
        );
    const email = cfg.psp_email || (await prompt({ message: "Enter email" }));
    const password =
        email &&
        (cfg.psp_password ||
            (await prompt({
                type: "password",
                message: "Enter password",
            })));

    // ### FILL IN EMAIL/PASS
    if (email && password) {
        await page.locator("#signin-entrance-input-signinId").fill(email);
        await page.locator("#signin-entrance-button").click(); // Next button
        await page.waitForSelector("#signin-password-input-password");
        await page.locator("#signin-password-input-password").fill(password);
        await page.locator("#signin-password-button").click();

        // ### CHECK FOR CAPTCHA
        page.locator("#FunCaptcha")
            .waitFor()
            .then(() => {
                console.error(
                    "Got a captcha during login (likely due to too many attempts)! You may solve it in the browser, get a new IP or try again in a few hours."
                );
                notify(
                    "playstation-plus: got captcha during login. Please check."
                );
            })
            .catch((_) => {});

        // handle MFA, but don't await it
        page.locator('input[title="Enter Code"]')
            .waitFor()
            .then(async () => {
                console.log("Two-Step Verification - Enter security code");
                console.log(
                    await page.locator(".description-regular").innerText()
                );
                const otp =
                    (cfg.psp_otpkey &&
                        authenticator.generate(cfg.psp_otpkey)) ||
                    (await prompt({
                        type: "text",
                        message: "Enter two-factor sign in code",
                        validate: (n) =>
                            n.toString().length == 6 ||
                            "The code must be 6 digits!",
                    })); // can't use type: 'number' since it strips away leading zeros and codes sometimes have them
                await page.type('input[title="Enter Code"]', otp.toString());
                await page
                    .locator(".checkbox-container")
                    .locator("button")
                    .click(); // Trust this Browser
                await page.click("button.primary-button");
            })
            .catch((_) => {});
    } else {
        console.log("Waiting for you to login in the browser.");
        await notify(
            "playstation-plus: no longer signed in and not enough options set for automatic login."
        );
        if (cfg.headless) {
            console.log(
                "Run `SHOW=1 node playstation-plus` to login in the opened browser."
            );
            await context.close();
            process.exit(1);
        }
    }

    // ### VERIFY SIGNED IN
    await page.waitForSelector(".psw-c-secondary");
    if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);
}

async function getAndSaveUser() {
    user = await page.locator(".psw-c-secondary").innerText(); // innerText is uppercase due to styling!
    console.log(`Signed in as '${user}'`);
    db.data[user] ||= {};
}

async function redeemFreeGames() {
    // ### GET LIST OF FREE GAMES
    const monthlyGamesBlock = await page.locator(
        ".cmp-experiencefragment--your-latest-monthly-games"
    );
    const monthlyGamesLocator = await monthlyGamesBlock.locator(".box").all();

    const monthlyGamesPageLinks = await Promise.all(
        monthlyGamesLocator.map(async (el) => {
            const urlSlug = await el
                .locator(".cta__primary")
                .getAttribute("href");
            return urlSlug.charAt(0) === "/"
                ? `https://www.playstation.com${urlSlug}`
                : urlSlug;
        })
    );
    console.log("Free games:", monthlyGamesPageLinks);

    for (const url of monthlyGamesPageLinks) {
        await page.goto(url);

        // TODO add logic to handle playstation.com vs store.playstation.com since some games are linked to different subdomains
        const gameCard = page.locator(".content-grid").first();
        await gameCard.waitFor();
        const title = await gameCard.locator("h1").first().innerText();
        const game_id = page.url().split("/").pop();
        db.data[user][game_id] ||= { title, time: datetime(), url: page.url() }; // this will be set on the initial run only!
        console.log("Current free game:", title);
        const notify_game = { title, url, status: "failed" };
        notify_games.push(notify_game); // status is updated below

        // SELECTORS
        const inLibrary = gameCard
            .locator('span:has-text("In library")')
            .first();
        const addToLibrary = gameCard
            .locator('span:has-text("Add to Library")')
            .nth(1);

        await Promise.any([addToLibrary.waitFor(), inLibrary.waitFor()]);

        if (await inLibrary.isVisible()) {
            console.log("  Already in library! Nothing to claim.");
            notify_game.status = "existed";
            db.data[user][game_id].status ||= "existed"; // does not overwrite claimed or failed
        } else if (await addToLibrary.isVisible()) {
            console.log("  Not in library yet! Click ADD TO LIBRARY.");
            await addToLibrary.click();

            await inLibrary.waitFor();
            db.data[user][game_id].status = "claimed";
            db.data[user][game_id].time = datetime(); // claimed time overwrites failed/dryrun time
            console.log("  Claimed successfully!");
        }

        notify_game.status = db.data[user][game_id].status; // claimed or failed

        // const p = path.resolve(cfg.dir.screenshots, playstation-plus', `${game_id}.png`);
        // if (!existsSync(p)) await page.screenshot({ path: p, fullPage: false }); // fullPage is quite long...
    }
}
