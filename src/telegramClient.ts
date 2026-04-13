import { elizaLogger, type IAgentRuntime } from "@elizaos/core";

type TelegramUpdate = {
    update_id: number;
    message?: {
        chat?: { id?: number | string; type?: string };
        from?: { id?: number | string; username?: string; first_name?: string };
        text?: string;
    };
    callback_query?: {
        id: string;
        data?: string;
        from?: { id?: number | string; username?: string; first_name?: string };
        message?: {
            chat?: { id?: number | string; type?: string };
        };
    };
};

type TelegramResponse<T> = {
    ok: boolean;
    result: T;
    description?: string;
};

type TelegramInlineButton = {
    text: string;
    callback_data?: string;
    url?: string;
};

type TelegramBotCommand = {
    command: string;
    description: string;
};

function envValue(name: string, fallback = "") {
    return process.env[`AIRIFICA_${name}`] ?? process.env[`AIRI3_${name}`] ?? fallback;
}

function compact(text: string) {
    return text.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function describeError(error: unknown) {
    if (error instanceof Error)
        return error.message;
    return String(error ?? "unknown error");
}

function formatUsdCompact(value: number) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric))
        return "0.00";
    return numeric.toFixed(Math.abs(numeric) >= 100 ? 2 : 4);
}

export class TelegramAirificaClient {
    private runtime: IAgentRuntime;
    private running = false;
    private updateOffset = 0;
    private pollPromise: Promise<void> | null = null;
    private alertPromise: Promise<void> | null = null;
    private readonly botToken: string;
    private readonly runtimeBaseUrl: string;
    private readonly internalSecret: string;
    private readonly pollTimeoutSeconds: number;
    private readonly alertPollMs: number;
    private readonly publicAppUrl: string;
    private readonly botUsername: string;

    constructor(runtime: IAgentRuntime) {
        this.runtime = runtime;
        const port = Number(
            runtime.getSetting("AIRIFICA_PORT")
            || runtime.getSetting("AIRI3_PORT")
            || process.env.AIRIFICA_PORT
            || process.env.AIRI3_PORT
            || 4040,
        );
        this.botToken = String(
            runtime.getSetting("AIRIFICA_TELEGRAM_BOT_TOKEN")
            || runtime.getSetting("AIRI3_TELEGRAM_BOT_TOKEN")
            || envValue("TELEGRAM_BOT_TOKEN")
            || "",
        ).trim();
        this.runtimeBaseUrl = String(
            runtime.getSetting("AIRIFICA_TELEGRAM_RUNTIME_BASE_URL")
            || envValue("TELEGRAM_RUNTIME_BASE_URL", `http://127.0.0.1:${port}`)
        ).replace(/\/+$/, "");
        this.internalSecret = String(
            runtime.getSetting("AIRIFICA_TELEGRAM_INTERNAL_SECRET")
            || envValue("TELEGRAM_INTERNAL_SECRET")
            || this.botToken
        ).trim();
        this.pollTimeoutSeconds = Math.max(10, Number(envValue("TELEGRAM_POLL_TIMEOUT_SECONDS", "50")));
        this.alertPollMs = Math.max(2000, Number(envValue("TELEGRAM_ALERT_POLL_MS", "5000")));
        this.publicAppUrl = String(
            runtime.getSetting("AIRIFICA_PUBLIC_APP_URL")
            || runtime.getSetting("AIRI3_PUBLIC_APP_URL")
            || envValue("PUBLIC_APP_URL")
            || "",
        ).trim().replace(/\/+$/, "");
        this.botUsername = String(
            runtime.getSetting("AIRIFICA_TELEGRAM_BOT_USERNAME")
            || runtime.getSetting("AIRI3_TELEGRAM_BOT_USERNAME")
            || envValue("TELEGRAM_BOT_USERNAME")
            || "",
        ).trim().replace(/^@/, "");
    }

    private get apiBase() {
        return `https://api.telegram.org/bot${this.botToken}`;
    }

    private async telegramApi<T>(method: string, payload: Record<string, unknown>) {
        const response = await fetch(`${this.apiBase}/${method}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        const json = await response.json() as TelegramResponse<T>;
        if (!response.ok || !json.ok)
            throw new Error(json.description || `Telegram API ${method} failed`);
        return json.result;
    }

    private async internalApi<T>(pathname: string, init?: RequestInit) {
        const response = await fetch(`${this.runtimeBaseUrl}${pathname}`, {
            ...init,
            headers: {
                "Content-Type": "application/json",
                "x-airifica-internal-secret": this.internalSecret,
                ...(init?.headers || {}),
            },
        });
        const raw = await response.text();
        const payload = raw ? JSON.parse(raw) as T & { ok?: boolean; error?: string } : null;
        if (!response.ok || (payload && typeof payload === "object" && payload.ok === false))
            throw new Error((payload as any)?.error || `Internal API ${pathname} failed`);
        return payload as T;
    }

    private async sendMessage(chatId: string, text: string, options?: { inlineKeyboard?: Array<Array<TelegramInlineButton>> }) {
        const payload: Record<string, unknown> = {
            chat_id: chatId,
            text,
        };
        if (options?.inlineKeyboard?.length) {
            payload.reply_markup = {
                inline_keyboard: options.inlineKeyboard,
            };
        }
        await this.telegramApi("sendMessage", payload);
    }

    private async answerCallbackQuery(callbackQueryId: string, text?: string) {
        await this.telegramApi("answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            ...(text ? { text } : {}),
        });
    }

    private async setCommands(commands: TelegramBotCommand[]) {
        await this.telegramApi("setMyCommands", {
            commands,
        });
    }

    private getConnectWebUrl() {
        if (!this.publicAppUrl)
            return "";
        const url = new URL(this.publicAppUrl);
        url.searchParams.set("telegram", "connect");
        url.searchParams.set("source", "telegram_bot");
        return url.toString();
    }

    private getBotUrl() {
        return this.botUsername ? `https://t.me/${this.botUsername}` : "";
    }

    private async getLinkStatus(chatId: string) {
        return await this.internalApi<any>("/api/airi3/telegram/internal/link/status", {
            method: "POST",
            body: JSON.stringify({ chatId }),
        });
    }

    private buildHomeKeyboard(linked: boolean, alertsEnabled = true) {
        const keyboard: Array<Array<TelegramInlineButton>> = [];
        const connectWebUrl = this.getConnectWebUrl();
        const botUrl = this.getBotUrl();

        if (connectWebUrl) {
            keyboard.push([
                { text: linked ? "Open Airifica" : "Link wallet in Airifica", url: connectWebUrl },
            ]);
        } else if (botUrl) {
            keyboard.push([
                { text: "Open bot", url: botUrl },
            ]);
        }

        keyboard.push([
            { text: "Positions", callback_data: "nav:positions" },
            { text: "Status", callback_data: "nav:status" },
        ]);

        if (linked) {
            keyboard.push([
                { text: alertsEnabled ? "Alerts: on" : "Alerts: off", callback_data: alertsEnabled ? "alerts:off" : "alerts:on" },
                { text: "Chat settings", callback_data: "nav:status" },
            ]);
            keyboard.push([
                { text: "Refresh", callback_data: "nav:home" },
            ]);
        }

        return keyboard;
    }

    private buildStatusKeyboard(link: { alertsEnabled?: boolean, conversationalEnabled?: boolean } | null) {
        if (!link)
            return this.buildHomeKeyboard(false);

        return [
            [
                {
                    text: link.alertsEnabled ? "Alerts: on" : "Alerts: off",
                    callback_data: link.alertsEnabled ? "alerts:off" : "alerts:on",
                },
                {
                    text: link.conversationalEnabled ? "Chat: on" : "Chat: off",
                    callback_data: link.conversationalEnabled ? "chat:off" : "chat:on",
                },
            ],
            [
                { text: "Positions", callback_data: "nav:positions" },
                { text: "Home", callback_data: "nav:home" },
            ],
        ];
    }

    private async sendHome(chatId: string) {
        let status: any = null;
        try {
            status = await this.getLinkStatus(chatId);
        } catch {
        }

        const link = status?.link || null;
        const summary = status?.summary || null;
        const linked = Boolean(link);
        const lines = linked
            ? [
                "Airifica Telegram control surface.",
                "",
                `Wallet: ${link.walletAddress}`,
                summary ? `Equity: ${formatUsdCompact(summary.equityUsd)} USD` : null,
                summary ? `Available: ${formatUsdCompact(summary.availableUsd)} USD` : null,
                summary ? `Open positions: ${summary.positionsCount}` : null,
                summary ? `PnL: ${summary.totalPnlUsd >= 0 ? "+" : ""}${formatUsdCompact(summary.totalPnlUsd)} USD` : null,
                `Alerts: ${link.alertsEnabled ? "on" : "off"}`,
                `Conversation: ${link.conversationalEnabled ? "on" : "off"}`,
                summary?.latestTrade
                    ? `Last trade: ${summary.latestTrade.side} ${summary.latestTrade.symbol}${summary.latestTrade.orderId ? ` (${summary.latestTrade.orderId})` : ""}`
                    : null,
                "",
                "Use the buttons below or send a natural-language message.",
            ].filter(Boolean) as string[]
            : [
                "Airifica Telegram control surface.",
                "",
                "This chat is not linked yet.",
                "Open Airifica, connect your wallet, then tap Connect Telegram.",
                "",
                "Manual fallback: /link CODE",
            ];

        await this.sendMessage(chatId, compact(lines.join("\n")), {
            inlineKeyboard: this.buildHomeKeyboard(linked, Boolean(link?.alertsEnabled)),
        });
    }

    private parseCommand(text: string) {
        const trimmed = text.trim();
        if (!trimmed.startsWith("/"))
            return null;
        const [rawCommand, ...rest] = trimmed.split(/\s+/);
        const command = rawCommand.replace(/^\/+/, "").split("@")[0]?.toLowerCase() || "";
        return {
            command,
            args: rest,
            rawArgs: rest.join(" ").trim(),
        };
    }

    private async renderPositions(chatId: string) {
        const payload = await this.internalApi<any>("/api/airi3/telegram/internal/positions", {
            method: "POST",
            body: JSON.stringify({ chatId }),
        });
        const overview = payload.overview || {};
        const account = overview.account || {};
        const positions = Array.isArray(overview.positions) ? overview.positions : [];
        const lines = [
            `Wallet: ${payload.walletAddress}`,
            `Equity: ${Number(account.equityUsd || 0).toFixed(4)} USD`,
            `Available: ${Number(account.availableToSpendUsd || 0).toFixed(4)} USD`,
            `Open positions: ${positions.length}`,
        ];

        if (positions.length) {
            lines.push("");
            positions.slice(0, 8).forEach((position: any, index: number) => {
                lines.push(
                    `${index + 1}. ${position.symbol} ${position.side}`,
                    `amount=${Number(position.amount || 0).toFixed(6)} pnl=${Number(position.unrealizedPnlUsd || 0).toFixed(4)} usd`,
                );
            });
        }

        const keyboard = positions.slice(0, 6).map((position: any) => ([
            {
                text: `Close ${position.symbol} ${position.side}`,
                callback_data: `close:${position.symbol}:${position.side}`,
            },
        ]));

        await this.sendMessage(chatId, compact(lines.join("\n")), {
            inlineKeyboard: [
                ...keyboard,
                [
                    { text: "Refresh positions", callback_data: "nav:positions" },
                    { text: "Home", callback_data: "nav:home" },
                ],
            ],
        });
    }

    private async handleCommand(chatId: string, userId: string, username: string | null, firstName: string | null, text: string) {
        const parsed = this.parseCommand(text);
        if (!parsed)
            return false;

        if (parsed.command === "start") {
            const payload = parsed.rawArgs.startsWith("link_") ? parsed.rawArgs.slice(5) : parsed.rawArgs;
            if (payload) {
                const linkResult = await this.internalApi<any>("/api/airi3/telegram/internal/link/consume", {
                    method: "POST",
                    body: JSON.stringify({
                        code: payload,
                        chatId,
                        userId,
                        username,
                        firstName,
                    }),
                });
                await this.sendMessage(chatId, `Linked to wallet ${linkResult.link.walletAddress}. Alerts are on and chat is ready.`, {
                    inlineKeyboard: this.buildHomeKeyboard(true, Boolean(linkResult.link.alertsEnabled)),
                });
                return true;
            }

            await this.sendHome(chatId);
            return true;
        }

        if (parsed.command === "help" || parsed.command === "menu") {
            await this.sendHome(chatId);
            return true;
        }

        if (parsed.command === "settings") {
            await this.sendHome(chatId);
            return true;
        }

        if (parsed.command === "link") {
            if (!parsed.rawArgs) {
                await this.sendMessage(chatId, "Usage: /link YOUR_CODE");
                return true;
            }
            const linkResult = await this.internalApi<any>("/api/airi3/telegram/internal/link/consume", {
                method: "POST",
                body: JSON.stringify({
                    code: parsed.rawArgs,
                    chatId,
                    userId,
                    username,
                    firstName,
                }),
            });
            await this.sendMessage(chatId, `Linked to wallet ${linkResult.link.walletAddress}.`, {
                inlineKeyboard: this.buildHomeKeyboard(true, Boolean(linkResult.link.alertsEnabled)),
            });
            return true;
        }

        if (parsed.command === "status") {
            const status = await this.getLinkStatus(chatId);
            if (!status.link) {
                await this.sendHome(chatId);
                return true;
            }
            const summary = status.summary || null;
            await this.sendMessage(chatId, compact([
                `Linked wallet: ${status.link.walletAddress}`,
                summary ? `Equity: ${formatUsdCompact(summary.equityUsd)} USD` : null,
                summary ? `Available: ${formatUsdCompact(summary.availableUsd)} USD` : null,
                summary ? `Withdrawable: ${formatUsdCompact(summary.withdrawableUsd)} USD` : null,
                summary ? `Open positions: ${summary.positionsCount}` : null,
                summary ? `PnL: ${summary.totalPnlUsd >= 0 ? "+" : ""}${formatUsdCompact(summary.totalPnlUsd)} USD` : null,
                summary?.latestTrade
                    ? `Last trade: ${summary.latestTrade.side} ${summary.latestTrade.symbol}${summary.latestTrade.orderId ? ` (${summary.latestTrade.orderId})` : ""}`
                    : "Last trade: none",
                `Alerts: ${status.link.alertsEnabled ? "on" : "off"}`,
                `Conversation: ${status.link.conversationalEnabled ? "on" : "off"}`,
            ].filter(Boolean).join("\n")), {
                inlineKeyboard: this.buildStatusKeyboard(status.link),
            });
            return true;
        }

        if (parsed.command === "account" || parsed.command === "pnl") {
            const status = await this.getLinkStatus(chatId);
            if (!status.link) {
                await this.sendHome(chatId);
                return true;
            }
            const summary = status.summary || null;
            if (!summary) {
                await this.sendMessage(chatId, "Account snapshot is unavailable right now.");
                return true;
            }
            await this.sendMessage(chatId, compact([
                `Wallet: ${status.link.walletAddress}`,
                `Equity: ${formatUsdCompact(summary.equityUsd)} USD`,
                `Available: ${formatUsdCompact(summary.availableUsd)} USD`,
                `Withdrawable: ${formatUsdCompact(summary.withdrawableUsd)} USD`,
                `Open positions: ${summary.positionsCount}`,
                `PnL: ${summary.totalPnlUsd >= 0 ? "+" : ""}${formatUsdCompact(summary.totalPnlUsd)} USD`,
                summary.latestTrade
                    ? `Last trade: ${summary.latestTrade.side} ${summary.latestTrade.symbol}${summary.latestTrade.orderId ? ` (${summary.latestTrade.orderId})` : ""}`
                    : "Last trade: none",
            ].join("\n")), {
                inlineKeyboard: this.buildStatusKeyboard(status.link),
            });
            return true;
        }

        if (parsed.command === "alerts") {
            const value = parsed.args[0]?.toLowerCase();
            if (value !== "on" && value !== "off") {
                await this.sendMessage(chatId, "Usage: /alerts on|off");
                return true;
            }
            await this.internalApi("/api/airi3/telegram/internal/alerts/toggle", {
                method: "POST",
                body: JSON.stringify({ chatId, enabled: value === "on" }),
            });
            await this.sendMessage(chatId, `Alerts ${value === "on" ? "enabled" : "disabled"}.`, {
                inlineKeyboard: this.buildHomeKeyboard(true, value === "on"),
            });
            return true;
        }

        if (parsed.command === "chat") {
            const value = parsed.args[0]?.toLowerCase();
            if (value !== "on" && value !== "off") {
                await this.sendMessage(chatId, "Usage: /chat on|off");
                return true;
            }
            await this.internalApi("/api/airi3/telegram/internal/chat/toggle", {
                method: "POST",
                body: JSON.stringify({
                    chatId,
                    enabled: value === "on",
                }),
            });
            await this.sendMessage(chatId, `Telegram conversation ${value === "on" ? "enabled" : "disabled"}.`, {
                inlineKeyboard: this.buildHomeKeyboard(true),
            });
            return true;
        }

        if (parsed.command === "unlink") {
            await this.internalApi("/api/airi3/telegram/internal/unlink", {
                method: "POST",
                body: JSON.stringify({ chatId }),
            });
            await this.sendMessage(chatId, "Telegram chat unlinked from Airifica.", {
                inlineKeyboard: this.buildHomeKeyboard(false),
            });
            return true;
        }

        if (parsed.command === "positions") {
            await this.renderPositions(chatId);
            return true;
        }

        if (parsed.command === "close") {
            const symbol = parsed.args[0]?.toUpperCase();
            const side = parsed.args[1]?.toUpperCase();
            if (!symbol) {
                await this.sendMessage(chatId, "Usage: /close SYMBOL [LONG|SHORT]");
                return true;
            }

            const result = await this.internalApi<any>("/api/airi3/telegram/internal/close", {
                method: "POST",
                body: JSON.stringify({
                    chatId,
                    symbol,
                    ...(side === "LONG" || side === "SHORT" ? { side } : {}),
                }),
            });
            await this.sendMessage(chatId, `Closed ${result.closed.side} ${result.closed.symbol} (${result.closed.amount}).`, {
                inlineKeyboard: this.buildHomeKeyboard(true),
            });
            return true;
        }

        if (parsed.command === "open") {
            await this.sendHome(chatId);
            return true;
        }

        return false;
    }

    private async handleConversationalMessage(chatId: string, text: string) {
        try {
            const payload = await this.internalApi<any>("/api/airi3/telegram/internal/message", {
                method: "POST",
                body: JSON.stringify({ chatId, text }),
            });
            const responses = Array.isArray(payload.responses) ? payload.responses : [];
            if (!responses.length) {
                await this.sendMessage(chatId, "No response generated.", {
                    inlineKeyboard: this.buildHomeKeyboard(true),
                });
                return;
            }

            for (const response of responses) {
                const replyText = String(response?.message?.text || "").trim();
                if (replyText)
                    await this.sendMessage(chatId, replyText);
            }
        } catch (error) {
            const message = describeError(error);
            if (/not linked/i.test(message) || /link not found/i.test(message)) {
                await this.sendHome(chatId);
                return;
            }
            if (/conversation is disabled/i.test(message)) {
                await this.sendMessage(chatId, "Conversational replies are off for this chat. Use /chat on to re-enable them.", {
                    inlineKeyboard: this.buildHomeKeyboard(true),
                });
                return;
            }
            throw error;
        }
    }

    private async handleCallbackQuery(update: TelegramUpdate) {
        const callback = update.callback_query;
        if (!callback?.id)
            return;

        const chatId = String(callback.message?.chat?.id || "").trim();
        const chatType = String(callback.message?.chat?.type || "").trim();
        const data = String(callback.data || "");
        if (!chatId || !data || (chatType && chatType !== "private"))
            return;

        try {
            if (data === "nav:home") {
                await this.answerCallbackQuery(callback.id);
                await this.sendHome(chatId);
                return;
            }

            if (data === "nav:positions") {
                await this.answerCallbackQuery(callback.id);
                await this.renderPositions(chatId);
                return;
            }

            if (data === "nav:status") {
                const status = await this.getLinkStatus(chatId);
                await this.answerCallbackQuery(callback.id);
                if (!status.link) {
                    await this.sendHome(chatId);
                    return;
                }
                const summary = status.summary || null;
                await this.sendMessage(chatId, compact([
                    `Linked wallet: ${status.link.walletAddress}`,
                    summary ? `Equity: ${formatUsdCompact(summary.equityUsd)} USD` : null,
                    summary ? `Available: ${formatUsdCompact(summary.availableUsd)} USD` : null,
                    summary ? `Open positions: ${summary.positionsCount}` : null,
                    summary ? `PnL: ${summary.totalPnlUsd >= 0 ? "+" : ""}${formatUsdCompact(summary.totalPnlUsd)} USD` : null,
                    summary?.latestTrade
                        ? `Last trade: ${summary.latestTrade.side} ${summary.latestTrade.symbol}${summary.latestTrade.orderId ? ` (${summary.latestTrade.orderId})` : ""}`
                        : null,
                    `Alerts: ${status.link.alertsEnabled ? "on" : "off"}`,
                    `Conversation: ${status.link.conversationalEnabled ? "on" : "off"}`,
                ].filter(Boolean).join("\n")), {
                    inlineKeyboard: this.buildStatusKeyboard(status.link),
                });
                return;
            }

            if (data === "alerts:on" || data === "alerts:off") {
                const enabled = data === "alerts:on";
                await this.internalApi("/api/airi3/telegram/internal/alerts/toggle", {
                    method: "POST",
                    body: JSON.stringify({ chatId, enabled }),
                });
                await this.answerCallbackQuery(callback.id, enabled ? "Alerts enabled" : "Alerts disabled");
                await this.sendHome(chatId);
                return;
            }

            if (data === "chat:on" || data === "chat:off") {
                const enabled = data === "chat:on";
                const status = await this.getLinkStatus(chatId);
                if (!status.link) {
                    await this.answerCallbackQuery(callback.id, "Chat not linked");
                    await this.sendHome(chatId);
                    return;
                }
                await this.internalApi("/api/airi3/telegram/internal/chat/toggle", {
                    method: "POST",
                    body: JSON.stringify({ chatId, enabled }),
                });
                await this.answerCallbackQuery(callback.id, enabled ? "Conversation enabled" : "Conversation disabled");
                await this.sendHome(chatId);
                return;
            }

            if (data.startsWith("close:")) {
                const [, symbol, side] = data.split(":");
                const result = await this.internalApi<any>("/api/airi3/telegram/internal/close", {
                    method: "POST",
                    body: JSON.stringify({
                        chatId,
                        symbol,
                        ...(side ? { side } : {}),
                    }),
                });
                await this.answerCallbackQuery(callback.id, `Closed ${result.closed.symbol}`);
                await this.sendMessage(chatId, `Closed ${result.closed.side} ${result.closed.symbol} (${result.closed.amount}).`, {
                    inlineKeyboard: this.buildHomeKeyboard(true),
                });
                return;
            }

            await this.answerCallbackQuery(callback.id, "Unsupported action.");
        } catch (error: any) {
            await this.answerCallbackQuery(callback.id, error?.message || "Action failed");
        }
    }

    private async handleUpdate(update: TelegramUpdate) {
        if (typeof update.update_id === "number")
            this.updateOffset = Math.max(this.updateOffset, update.update_id + 1);

        if (update.callback_query) {
            await this.handleCallbackQuery(update);
            return;
        }

        const message = update.message;
        const text = String(message?.text || "").trim();
        const chatId = String(message?.chat?.id || "").trim();
        const chatType = String(message?.chat?.type || "").trim();
        const userId = String(message?.from?.id || "").trim();
        const username = message?.from?.username || null;
        const firstName = message?.from?.first_name || null;
        if (!text || !chatId || !userId || (chatType && chatType !== "private"))
            return;

        try {
            const wasCommandHandled = await this.handleCommand(chatId, userId, username, firstName, text);
            if (wasCommandHandled)
                return;

            await this.handleConversationalMessage(chatId, text);
        } catch (error: any) {
            await this.sendMessage(chatId, error?.message || "Telegram bot request failed.");
        }
    }

    private async pollLoop() {
        while (this.running) {
            try {
                const updates = await this.telegramApi<TelegramUpdate[]>("getUpdates", {
                    offset: this.updateOffset,
                    timeout: this.pollTimeoutSeconds,
                    allowed_updates: ["message", "callback_query"],
                });
                for (const update of updates)
                    await this.handleUpdate(update);
            } catch (error) {
                elizaLogger.warn(`[client-telegram-airifica] polling failed: ${describeError(error)}`);
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
    }

    private async alertLoop() {
        while (this.running) {
            try {
                const payload = await this.internalApi<any>("/api/airi3/telegram/internal/alerts/pending?limit=20", {
                    method: "GET",
                });
                const alerts = Array.isArray(payload.alerts) ? payload.alerts : [];
                for (const alert of alerts) {
                    try {
                        await this.sendMessage(String(alert.chatId), String(alert.text || ""));
                        await this.internalApi(`/api/airi3/telegram/internal/alerts/${alert.id}/delivered`, {
                            method: "POST",
                            body: JSON.stringify({}),
                        });
                    } catch (error: any) {
                        await this.internalApi(`/api/airi3/telegram/internal/alerts/${alert.id}/failed`, {
                            method: "POST",
                            body: JSON.stringify({ error: error?.message || "delivery failed" }),
                        });
                    }
                }
            } catch (error) {
                elizaLogger.warn(`[client-telegram-airifica] alert drain failed: ${describeError(error)}`);
            }

            await new Promise(resolve => setTimeout(resolve, this.alertPollMs));
        }
    }

    public async start(): Promise<boolean> {
        if (!this.botToken) {
            elizaLogger.warn("[client-telegram-airifica] AIRIFICA_TELEGRAM_BOT_TOKEN missing; Telegram bot disabled");
            return false;
        }

        this.running = true;
        try {
            await this.telegramApi("deleteWebhook", { drop_pending_updates: true });
        } catch (error) {
            elizaLogger.warn(`[client-telegram-airifica] deleteWebhook skipped: ${describeError(error)}`);
        }
        try {
            await this.setCommands([
                { command: "start", description: "Open the Airifica Telegram home" },
                { command: "positions", description: "View open Pacifica positions" },
                { command: "status", description: "Show linked wallet and bot status" },
                { command: "account", description: "Show account funds, PnL and last trade" },
                { command: "alerts", description: "Toggle Telegram alerts on or off" },
                { command: "chat", description: "Enable or disable conversational replies" },
                { command: "close", description: "Close an open Pacifica position" },
                { command: "unlink", description: "Unlink this Telegram chat from Airifica" },
            ]);
        } catch (error) {
            elizaLogger.warn(`[client-telegram-airifica] setMyCommands skipped: ${describeError(error)}`);
        }

        this.pollPromise = this.pollLoop();
        this.alertPromise = this.alertLoop();
        elizaLogger.success("[client-telegram-airifica] Telegram bot started");
        return true;
    }

    public async stop(): Promise<void> {
        this.running = false;
        await Promise.allSettled([
            this.pollPromise,
            this.alertPromise,
        ]);
    }
}
