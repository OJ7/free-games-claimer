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

try {
    await performLogin();
    await getAndSaveUser();
    await redeemFreeGames();
} catch (error) {
    console.error(error);
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
    await page.goto(URL_CLAIM, { waitUntil: "domcontentloaded" }); // default 'load' takes forever

    const signInLocator = page
        .getByRole("link", {
            name: "Sign in to your account",
        })
        .first();
    const usernameLocator = page.locator(".mectrl_truncate").first();

    await Promise.any([signInLocator, usernameLocator]);

    if (usernameLocator.isVisible()) {
        return; // logged in using saved cookie
    } else if (await signInLocator.isVisible()) {
        console.error("Not signed in anymore.");
        await signInLocator.click();
        await signInToXbox();
    } else {
        // lost! where am i?
    }
}

async function signInToXbox() {
    page.waitForLoadState("domcontentloaded");
    if (!cfg.debug) context.setDefaultTimeout(cfg.login_timeout); // give user some extra time to log in
    console.info(`Login timeout is ${cfg.login_timeout / 1000} seconds!`);

    // ### FETCH EMAIL/PASS
    if (cfg.xbox_email && cfg.xbox_password)
        console.info("Using email and password from environment.");
    else
        console.info(
            "Press ESC to skip the prompts if you want to login in the browser (not possible in headless mode)."
        );
    const email = cfg.xbox_email || (await prompt({ message: "Enter email" }));
    const password =
        email &&
        (cfg.xbox_password ||
            (await prompt({
                type: "password",
                message: "Enter password",
            })));
    // TODO implement OTP key
    // ### FILL IN EMAIL/PASS
    if (email && password) {
        await page.getByPlaceholder("Email, phone, or Skype").fill(email);
        await page.getByRole("button", { name: "Next" }).click();
        await page.getByPlaceholder("Password").fill(password);
        await page.getByRole("button", { name: "Sign in" }).click();
        await page.getByLabel("Don't show this again").check();
        await page.getByRole("button", { name: "Yes" }).click();
    } else {
        console.log("Waiting for you to login in the browser.");
        await notify(
            "xbox: no longer signed in and not enough options set for automatic login."
        );
        if (cfg.headless) {
            console.log(
                "Run `SHOW=1 node xbox` to login in the opened browser."
            );
            await context.close();
            process.exit(1);
        }
    }

    // ### VERIFY SIGNED IN
    await page.waitForSelector("#mectrl_currentAccount_primary");
    if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);
}

async function getAndSaveUser() {
    user = await page.locator("#mectrl_currentAccount_primary").innerHTML();
    console.log(`Signed in as '${user}'`);
    db.data[user] ||= {};
}

async function redeemFreeGames() {
    const monthlyGamesLocator = await page.locator(".f-size-large").all();

    const monthlyGamesPageLinks = await Promise.all(
        monthlyGamesLocator.map(
            async (el) => await el.locator("a").getAttribute("href")
        )
    );
    console.log("Free games:", monthlyGamesPageLinks);

    for (const url of monthlyGamesPageLinks) {
        await page.goto(url);

        const title = await page.locator("h1").first().innerText();
        const game_id = page.url().split("/").pop();
        db.data[user][game_id] ||= { title, time: datetime(), url: page.url() }; // this will be set on the initial run only!
        console.log("Current free game:", title);
        const notify_game = { title, url, status: "failed" };
        notify_games.push(notify_game); // status is updated below

        // SELECTORS
        const getBtnLocator = page.getByText("GET", { exact: true }).first();
        const installToLocator = page
            .getByText("INSTALL TO", { exact: true })
            .first();

        await Promise.any([
            getBtnLocator.waitFor(),
            installToLocator.waitFor(),
        ]);

        if (await installToLocator.isVisible()) {
            console.log("  Already in library! Nothing to claim.");
            notify_game.status = "existed";
            db.data[user][game_id].status ||= "existed"; // does not overwrite claimed or failed
        } else if (await getBtnLocator.isVisible()) {
            console.log("  Not in library yet! Click GET.");
            await getBtnLocator.click();

            // wait for popup
            await page
                .locator('iframe[name="purchase-sdk-hosted-iframe"]')
                .waitFor();
            const popupLocator = page.frameLocator(
                "[name=purchase-sdk-hosted-iframe]"
            );

            const finalGetBtnLocator = popupLocator.getByText("GET");
            await finalGetBtnLocator.waitFor();
            await finalGetBtnLocator.click();

            await page.getByText("Thank you for your purchase.").waitFor();
            notify_game.status = "claimed";
            db.data[user][game_id].status = "claimed";
            db.data[user][game_id].time = datetime(); // claimed time overwrites failed/dryrun time
            console.log("  Claimed successfully!");
        }

        // notify_game.status = db.data[user][game_id].status; // claimed or failed

        // const p = path.resolve(cfg.dir.screenshots, playstation-plus', `${game_id}.png`);
        // if (!existsSync(p)) await page.screenshot({ path: p, fullPage: false }); // fullPage is quite long...
    }
}
