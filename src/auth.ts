/**
 * QR code login flow for WeChat iLink Bot.
 * Scans QR → gets bot_token → saves credentials to ~/.weixin-ai-bridge/account.json
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetchQRCode, pollQRStatus } from "./weixin-api.js";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const DATA_DIR = process.env.WEIXIN_BRIDGE_DATA_DIR
  || path.join(os.homedir(), ".weixin-ai-bridge");
const ACCOUNT_FILE = path.join(DATA_DIR, "account.json");

export interface AccountData {
  token: string;
  baseUrl: string;
  accountId: string;
  userId?: string;
  savedAt: string;
}

export function loadAccount(): AccountData | null {
  try {
    if (!fs.existsSync(ACCOUNT_FILE)) return null;
    return JSON.parse(fs.readFileSync(ACCOUNT_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function saveAccount(data: AccountData): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ACCOUNT_FILE, JSON.stringify(data, null, 2), "utf-8");
  try { fs.chmodSync(ACCOUNT_FILE, 0o600); } catch { /* best-effort */ }
}

export async function loginWithQR(): Promise<AccountData> {
  console.log("正在获取微信登录二维码...\n");

  const qr = await fetchQRCode(DEFAULT_BASE_URL);

  // Display QR in terminal
  try {
    const qrterm = await import("qrcode-terminal");
    await new Promise<void>((resolve) => {
      qrterm.default.generate(qr.qrcode_img_content, { small: true }, (str: string) => {
        console.log(str);
        resolve();
      });
    });
  } catch {
    console.log(`二维码链接: ${qr.qrcode_img_content}`);
  }

  console.log("\n请用微信扫描上方二维码...\n");

  // Poll for scan result
  const deadline = Date.now() + 5 * 60_000;
  let scannedPrinted = false;

  while (Date.now() < deadline) {
    const status = await pollQRStatus(DEFAULT_BASE_URL, qr.qrcode);

    switch (status.status) {
      case "wait":
        break;
      case "scaned":
        if (!scannedPrinted) {
          console.log("👀 已扫码，请在微信上确认...");
          scannedPrinted = true;
        }
        break;
      case "expired":
        throw new Error("二维码已过期，请重新运行登录。");
      case "confirmed": {
        if (!status.bot_token || !status.ilink_bot_id) {
          throw new Error("登录确认但缺少 token 或 bot_id");
        }
        const account: AccountData = {
          token: status.bot_token,
          baseUrl: status.baseurl || DEFAULT_BASE_URL,
          accountId: status.ilink_bot_id,
          userId: status.ilink_user_id,
          savedAt: new Date().toISOString(),
        };
        saveAccount(account);
        console.log("\n✅ 微信连接成功！凭证已保存。\n");
        return account;
      }
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  throw new Error("登录超时，请重试。");
}
