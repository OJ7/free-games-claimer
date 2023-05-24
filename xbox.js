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
const URL_CLAIM = "https://www.xbox.com/en-US/live/gold"; // #gameswithgold";

console.log(datetime(), "started checking xbox");

const db = await jsonDb("xbox.json");
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

const notify_games = [];
let user;

// SELECTORS
// '.mectrl_truncate' username

// '.gameDivsWrapper' container for free games list
// 'a' [] - list of games links (grab href)

try {
    await performLogin();
    await getAndSaveUser();
    await redeemFreeGames();
} catch (error) {
    console.error(error); // .toString()?
    process.exitCode ||= 1;
    if (error.message && process.exitCode != 130)
        notify(`xbox failed: ${error.message.split("\n")[0]}`);
} finally {
    await db.write(); // write out json db
    if (notify_games.filter((g) => g.status != "existed").length) {
        // don't notify if all were already claimed
        notify(`xbox (${user}):<br>${html_game_list(notify_games)}`);
    }
    await context.close();
}

async function performLogin() {
    await page.goto(URL_CLAIM);

    // CHECK AND LOGIN
    const signInLocator = page
        .getByRole("link", {
            name: "Sign in to your account",
        })
        .first();
    const usernameLocator = page.locator(".mectrl_truncate").first();

    await Promise.any([signInLocator, usernameLocator]);

    if (await signInLocator.isVisible()) {
        await signInLocator.click();

        // TODO email/pass stuff from config + logs

        const email =
            cfg.xbox_email || (await prompt({ message: "Enter email" }));
        const password =
            email &&
            (cfg.xbox_password ||
                (await prompt({
                    type: "password",
                    message: "Enter password",
                })));

        await page
            .getByPlaceholder("Email, phone, or Skype")
            .fill(email);
        await page.getByRole("button", { name: "Next" }).click();
        await page.getByPlaceholder("Password").fill(password);
        await page.getByRole("button", { name: "Sign in" }).click();
        await page.getByLabel("Don't show this again").check();
        await page.getByRole("button", { name: "Yes" }).click();
    }
}

async function getAndSaveUser() {
    user = await page.locator("#mectrl_currentAccount_primary").innerHTML();
    console.log(`Signed in as '${user}'`);
    db.data[user] ||= {};
}

async function redeemFreeGames() {
    // CLAIM FREE GAMES
    const monthlyGamesLocator = await page.locator(".f-size-large").all();

    const monthlyGamesPageLinks = await Promise.all(
        monthlyGamesLocator.map(
            async (el) => await el.locator("a").getAttribute("href")
        )
    );
    console.log("Free games:", monthlyGamesPageLinks);

    for (const url of monthlyGamesPageLinks) {
        await page.goto(url);

        // TODO DB stuff for notify

        // SELECTORS
        const getBtnLocator = page
            .locator(".glyph-prepend-xbox-gold-inline")
            .first();
        const installToLocator = page
            .locator('div:has-text("INSTALL TO")')
            .first();

        await Promise.any([getBtnLocator, installToLocator]);

        if (getBtnLocator.isVisible()) {
            await getBtnLocator.click();

            // TODO this part not working
            const popupLocator = page.locator(".buynow");
            await popupLocator.waitFor(); // wait for popup

            const finalGetBtnLocator = popupLocator.getByText("GET");
            await finalGetBtnLocator.waitFor();
            await finalGetBtnLocator.click();
        } else if (installToLocator.isVisible()) {
            // already claimed
        }
    }
}

// ---------------------
await context.close();
