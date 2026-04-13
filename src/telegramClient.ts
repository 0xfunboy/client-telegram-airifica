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

    private async sendMessage(chatId: string, text: string, options?: { inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>> }) {
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
            inlineKeyboard: keyboard,
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
                await this.sendMessage(chatId, `Linked to wallet ${linkResult.link.walletAddress}. Alerts are on and chat is ready.`);
                return true;
            }

            await this.sendMessage(chatId, compact([
                "Airifica Telegram bot.",
                "",
                "Commands:",
                "/link CODE",
                "/positions",
                "/close SYMBOL",
                "/alerts on|off",
                "/status",
                "/unlink",
                "",
                "Any plain message after linking is sent to the Airifica conversational runtime.",
            ].join("\n")));
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
            await this.sendMessage(chatId, `Linked to wallet ${linkResult.link.walletAddress}.`);
            return true;
        }

        if (parsed.command === "status") {
            const status = await this.internalApi<any>("/api/airi3/telegram/internal/link/status", {
                method: "POST",
                body: JSON.stringify({ chatId }),
            });
            if (!status.link) {
                await this.sendMessage(chatId, "This Telegram chat is not linked yet.");
                return true;
            }
            await this.sendMessage(chatId, compact([
                `Linked wallet: ${status.link.walletAddress}`,
                `Alerts: ${status.link.alertsEnabled ? "on" : "off"}`,
                `Conversation: ${status.link.conversationalEnabled ? "on" : "off"}`,
            ].join("\n")));
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
            await this.sendMessage(chatId, `Alerts ${value === "on" ? "enabled" : "disabled"}.`);
            return true;
        }

        if (parsed.command === "unlink") {
            await this.internalApi("/api/airi3/telegram/internal/unlink", {
                method: "POST",
                body: JSON.stringify({ chatId }),
            });
            await this.sendMessage(chatId, "Telegram chat unlinked from Airifica.");
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
            await this.sendMessage(chatId, `Closed ${result.closed.side} ${result.closed.symbol} (${result.closed.amount}).`);
            return true;
        }

        return false;
    }

    private async handleConversationalMessage(chatId: string, text: string) {
        const payload = await this.internalApi<any>("/api/airi3/telegram/internal/message", {
            method: "POST",
            body: JSON.stringify({ chatId, text }),
        });
        const responses = Array.isArray(payload.responses) ? payload.responses : [];
        if (!responses.length) {
            await this.sendMessage(chatId, "No response generated.");
            return;
        }

        for (const response of responses) {
            const replyText = String(response?.message?.text || "").trim();
            if (replyText)
                await this.sendMessage(chatId, replyText);
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
                await this.sendMessage(chatId, `Closed ${result.closed.side} ${result.closed.symbol} (${result.closed.amount}).`);
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
