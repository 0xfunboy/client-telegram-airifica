import { elizaLogger, type IAgentRuntime } from "@elizaos/core";

type TelegramUpdate = {
    update_id: number;
    message?: {
        message_id?: number;
        chat?: { id?: number | string; type?: string };
        from?: { id?: number | string; username?: string; first_name?: string };
        text?: string;
    };
    callback_query?: {
        id: string;
        data?: string;
        from?: { id?: number | string; username?: string; first_name?: string };
        message?: {
            message_id?: number;
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

type TelegramProposalDraft = {
    kind: "pacifica" | "spot";
    chatId: string;
    proposalId: number;
    messageId: number;
    availableUsd: number;
    maxLeverage: number;
    leverage: number;
    collateralPct: number | null;
    collateralUsd: number | null;
    baseTokenAddress?: string | null;
    marketQuery?: string | null;
    proposal: any;
};

type PendingActionRequest = {
    kind: "chart" | "price" | "analysis" | "fundamentals" | "news" | "sentiment";
    promptPrefix: string;
    title: string;
};

type TelegramMessageOptions = {
    inlineKeyboard?: Array<Array<TelegramInlineButton>>;
    parseMode?: "HTML";
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

function escapeHtml(value: unknown) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function shortText(value: unknown, maxLength = 180) {
    const text = String(value ?? "").trim().replace(/\s+/g, " ");
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function shortWallet(value: unknown) {
    const text = String(value ?? "").trim();
    if (text.length <= 14)
        return text;
    return `${text.slice(0, 6)}…${text.slice(-6)}`;
}

function formatUsdCompact(value: number) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric))
        return "0.00";
    return numeric.toFixed(Math.abs(numeric) >= 100 ? 2 : 4);
}

function formatNumberCompact(value: number, decimals = 4) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric))
        return "0";
    return numeric.toLocaleString("en-US", {
        minimumFractionDigits: 0,
        maximumFractionDigits: decimals,
    });
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
    private readonly proposalDrafts = new Map<string, TelegramProposalDraft>();
    private readonly pendingCollateralInputs = new Map<string, { proposalId: number }>();
    private readonly pendingActionInputs = new Map<string, PendingActionRequest>();
    private heartbeatTimer: NodeJS.Timeout | null = null;

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
        if (!response.ok || (payload && typeof payload === "object" && payload.ok === false)) {
            const error: any = new Error((payload as any)?.error || `Internal API ${pathname} failed`);
            error.statusCode = response.status;
            error.payload = payload;
            throw error;
        }
        return payload as T;
    }

    private async trackEvent(chatId: string, category: "telegram_command" | "telegram_action" | "telegram_action_prompt", key: string) {
        try {
            await this.internalApi("/api/airi3/telegram/internal/analytics/event", {
                method: "POST",
                body: JSON.stringify({
                    chatId,
                    category,
                    key,
                }),
            });
        } catch (error) {
            elizaLogger.warn(`[client-telegram-airifica] analytics event failed: ${describeError(error)}`);
        }
    }

    private async sendRuntimeHeartbeat() {
        await this.internalApi("/api/airi3/telegram/internal/runtime/heartbeat", {
            method: "POST",
            body: JSON.stringify({
                botUsername: this.botUsername || null,
                runtimeBaseUrl: this.runtimeBaseUrl,
                pollTimeoutSeconds: this.pollTimeoutSeconds,
                alertPollMs: this.alertPollMs,
            }),
        });
    }

    private async sendActionTrace(chatId: string, label: string) {
        const text = String(label || "").trim();
        if (!text)
            return;

        await this.sendMessage(chatId, `<i>User request ${escapeHtml(text)}</i>`, {
            parseMode: "HTML",
        });
    }

    private async sendMessage(chatId: string, text: string, options?: TelegramMessageOptions) {
        const payload: Record<string, unknown> = {
            chat_id: chatId,
            text,
        };
        if (options?.parseMode)
            payload.parse_mode = options.parseMode;
        if (options?.inlineKeyboard?.length) {
            payload.reply_markup = {
                inline_keyboard: options.inlineKeyboard,
            };
        }
        return await this.telegramApi<any>("sendMessage", payload);
    }

    private async sendPhoto(chatId: string, image: string) {
        const trimmed = String(image || "").trim();
        if (!trimmed)
            return;

        if (/^https?:\/\//i.test(trimmed)) {
            await this.telegramApi("sendPhoto", {
                chat_id: chatId,
                photo: trimmed,
            });
            return;
        }

        const dataUriMatch = trimmed.match(/^data:([^;]+);base64,(.+)$/);
        if (!dataUriMatch)
            return;

        const [, mimeType, base64] = dataUriMatch;
        const bytes = Buffer.from(base64, "base64");
        const form = new FormData();
        form.append("chat_id", chatId);
        form.append("photo", new Blob([bytes], { type: mimeType }), "chart.png");

        const response = await fetch(`${this.apiBase}/sendPhoto`, {
            method: "POST",
            body: form,
        });
        const payload = await response.json() as TelegramResponse<unknown>;
        if (!response.ok || !payload.ok)
            throw new Error(payload.description || "Telegram API sendPhoto failed");
    }

    private async deleteMessage(chatId: string, messageId: number) {
        await this.telegramApi("deleteMessage", {
            chat_id: chatId,
            message_id: messageId,
        });
    }

    private async editMessageText(chatId: string, messageId: number, text: string, options?: TelegramMessageOptions) {
        const payload: Record<string, unknown> = {
            chat_id: chatId,
            message_id: messageId,
            text,
        };
        if (options?.parseMode)
            payload.parse_mode = options.parseMode;
        if (options?.inlineKeyboard?.length) {
            payload.reply_markup = {
                inline_keyboard: options.inlineKeyboard,
            };
        }
        await this.telegramApi("editMessageText", payload);
    }

    private async sendOrEditMessage(chatId: string, messageId: number | undefined, text: string, options?: TelegramMessageOptions) {
        if (Number.isFinite(messageId) && Number(messageId) > 0) {
            try {
                await this.editMessageText(chatId, Number(messageId), text, options);
            } catch (error) {
                if (/message is not modified/i.test(describeError(error)))
                    return;
                throw error;
            }
            return;
        }
        await this.sendMessage(chatId, text, options);
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

    private getJupiterUrl(mint: string | null | undefined) {
        const resolvedMint = String(mint || "").trim();
        if (!resolvedMint)
            return "";
        return `https://jup.ag/swap/SOL-${resolvedMint}`;
    }

    private getAirificaProposalUrl(input: {
        marketQuery: string;
        proposal: any;
        sizeUsd?: number | null;
        venue?: string | null;
    }) {
        if (!this.publicAppUrl)
            return "";

        const url = new URL(this.publicAppUrl);
        url.searchParams.set("source", "telegram_bot");
        url.searchParams.set("tgTrade", "1");
        url.searchParams.set("query", String(input.marketQuery || input.proposal?.symbol || "").trim());
        url.searchParams.set("symbol", String(input.proposal?.symbol || "").trim());
        url.searchParams.set("side", String(input.proposal?.side || "LONG").trim());
        url.searchParams.set("entry", String(Number(input.proposal?.entry || 0)));
        url.searchParams.set("tp", String(Number(input.proposal?.tp || 0)));
        url.searchParams.set("sl", String(Number(input.proposal?.sl || 0)));
        url.searchParams.set("timeframe", String(input.proposal?.timeframe || "1H").trim());
        url.searchParams.set("confidence", String(Number(input.proposal?.confidence || 0)));
        if (input.venue)
            url.searchParams.set("venue", String(input.venue).trim());
        const sizeUsd = Number(input.sizeUsd);
        if (Number.isFinite(sizeUsd) && sizeUsd > 0)
            url.searchParams.set("sizeUsd", String(sizeUsd));
        return url.toString();
    }

    private getDraftKey(chatId: string, proposalId: number) {
        return `${chatId}:${proposalId}`;
    }

    private buildPacificaTradeKeyboard(draft: {
        proposalId: number;
        marginPct: number | null;
        leverage: number;
        maxLeverage: number;
    }) {
        const leverageOptions = Array.from(new Set(
            [1, 2, 5, 10, 20, 50, Math.max(1, Math.trunc(draft.maxLeverage || 1))]
                .filter((value) => Number.isFinite(value) && value >= 1 && value <= Math.max(1, Math.trunc(draft.maxLeverage || 1))),
        )).sort((left, right) => left - right).slice(0, 4);

        const leverageButtons = leverageOptions.map((value) => ({
            text: value === draft.leverage ? `● ${value}x` : `${value}x`,
            callback_data: `tgp:l:${draft.proposalId}:${value}`,
        }));
        const collateralButtons = [10, 20, 30, 100].map((value) => ({
            text: value === 100
                ? (draft.marginPct === 100 ? "● MAX" : "MAX")
                : (draft.marginPct === value ? `● ${value}%` : `${value}%`),
            callback_data: `tgp:p:${draft.proposalId}:${value}`,
        }));

        return [
            leverageButtons,
            collateralButtons,
            [
                { text: "Set USD", callback_data: `tgp:s:${draft.proposalId}` },
                { text: "Execute", callback_data: `tgp:x:${draft.proposalId}` },
            ],
            [
                { text: "Refresh", callback_data: `tgp:r:${draft.proposalId}` },
            ],
        ];
    }

    private buildSpotTradeKeyboard(draft: {
        proposalId: number;
        selectedUsd: number | null;
        openUrl: string;
    }) {
        const spotSizes = [10, 25, 50, 100];
        const sizeButtons = spotSizes.map((value) => ({
            text: value === draft.selectedUsd ? `● ${value}$` : `${value}$`,
            callback_data: `tgp:p:${draft.proposalId}:${value}`,
        }));

        return [
            sizeButtons,
            [
                { text: "Set USD", callback_data: `tgp:s:${draft.proposalId}` },
                { text: "Open in Airifica", url: draft.openUrl },
            ],
            [{ text: "Refresh", callback_data: `tgp:r:${draft.proposalId}` }],
        ].filter(row => row.length > 0);
    }

    private buildProposalCardText(input: {
        symbol: string;
        timeframe: string;
        side: string;
        rr: number | null;
        confidencePct: number;
        entry: number;
        tp: number;
        sl: number;
        availableUsd: number;
        marginPct: number | null;
        marginUsd?: number | null;
        leverage: number;
        maxLeverage: number;
    }) {
        const explicitMarginUsd = input.marginUsd == null ? null : Number(input.marginUsd);
        const marginUsd = Math.max(0, Number.isFinite(explicitMarginUsd)
            ? Number(explicitMarginUsd)
            : input.marginPct != null
                ? input.availableUsd * (input.marginPct / 100)
                : 0);
        const notionalUsd = marginUsd * input.leverage;
        const quantity = input.entry > 0 ? notionalUsd / input.entry : 0;
        const rrText = Number.isFinite(input.rr) && input.rr && input.rr > 0 ? `R/R ${formatNumberCompact(input.rr, 2)}` : "R/R -";
        const selectedSize = input.marginPct != null
            ? `${input.marginPct}% of ${formatUsdCompact(input.availableUsd)} USD`
            : `custom ${formatUsdCompact(marginUsd)} USD`;
        return compact([
            `<b>$${escapeHtml(input.symbol)}</b> <i>${escapeHtml(input.timeframe)}</i> <u>${escapeHtml(input.side)}</u>`,
            `<b>${escapeHtml(rrText)}</b>  <b>Confidence</b> <code>${escapeHtml(`${input.confidencePct}%`)}</code>`,
            "",
            `<i>Execution setup</i>`,
            `<pre>Entry         ${escapeHtml(formatNumberCompact(input.entry, 6))}
Take profit   ${escapeHtml(formatNumberCompact(input.tp, 6))}
Stop loss     ${escapeHtml(formatNumberCompact(input.sl, 6))}</pre>`,
            `<b>Collateral</b> <code>${escapeHtml(formatUsdCompact(marginUsd))} USD</code>`,
            `<i>Selected size</i> <code>${escapeHtml(selectedSize)}</code>`,
            `<b>Leverage</b> <code>${escapeHtml(`${input.leverage}x / ${Math.max(1, input.maxLeverage)}x max`)}</code>`,
            `<b>Quantity</b> <code>${escapeHtml(`${formatNumberCompact(quantity, 6)} ${input.symbol}`)}</code>`,
            `<b>Position size</b> <code>${escapeHtml(`${formatUsdCompact(notionalUsd)} USD`)}</code>`,
            "",
            `<i>Available collateral</i> <code>${escapeHtml(`${formatUsdCompact(input.availableUsd)} USD`)}</code>`,
        ].join("\n"));
    }

    private buildSpotProposalCardText(input: {
        symbol: string;
        timeframe: string;
        side: string;
        rr: number | null;
        confidencePct: number;
        entry: number;
        tp: number;
        sl: number;
        sizeUsd: number;
    }) {
        const sizeUsd = Math.max(0, Number(input.sizeUsd || 0));
        const quantity = input.entry > 0 ? sizeUsd / input.entry : 0;
        const rrText = Number.isFinite(input.rr) && input.rr && input.rr > 0 ? `R/R ${formatNumberCompact(input.rr, 2)}` : "R/R -";

        return compact([
            `<b>$${escapeHtml(input.symbol)}</b> <i>${escapeHtml(input.timeframe)}</i> <u>${escapeHtml(input.side)}</u>`,
            `<b>${escapeHtml(rrText)}</b>  <b>Confidence</b> <code>${escapeHtml(`${input.confidencePct}%`)}</code>`,
            "",
            `<i>Spot execution handoff</i>`,
            `<pre>Entry         ${escapeHtml(formatNumberCompact(input.entry, 6))}
Take profit   ${escapeHtml(formatNumberCompact(input.tp, 6))}
Stop loss     ${escapeHtml(formatNumberCompact(input.sl, 6))}</pre>`,
            `<b>Budget</b> <code>${escapeHtml(`${formatUsdCompact(sizeUsd)} USD`)}</code>`,
            `<b>Quantity</b> <code>${escapeHtml(`${formatNumberCompact(quantity, 6)} ${input.symbol}`)}</code>`,
            `<b>Position size</b> <code>${escapeHtml(`${formatUsdCompact(sizeUsd)} USD`)}</code>`,
            "",
            "<i>Open Airifica to sign the swap with Phantom and execute on Jupiter.</i>",
        ].join("\n"));
    }

    private async replaceProposalCard(chatId: string, draft: TelegramProposalDraft) {
        const proposal = draft.proposal || {};
        const rewardRisk = proposal.side === "LONG"
            ? ((Number(proposal.tp) - Number(proposal.entry)) / Math.max(0.0000001, Number(proposal.entry) - Number(proposal.sl)))
            : ((Number(proposal.entry) - Number(proposal.tp)) / Math.max(0.0000001, Number(proposal.sl) - Number(proposal.entry)));
        const selectedSpotUsd = draft.collateralUsd != null
            ? Number(draft.collateralUsd)
            : Math.max(0, Number(draft.collateralPct || 0));
        const text = draft.kind === "spot"
            ? this.buildSpotProposalCardText({
                symbol: String(proposal.symbol || "TOKEN"),
                timeframe: String(proposal.timeframe || "1H"),
                side: String(proposal.side || "LONG"),
                rr: Number.isFinite(rewardRisk) ? rewardRisk : null,
                confidencePct: Math.round(Number(proposal.confidence || 0) * 100),
                entry: Number(proposal.entry || 0),
                tp: Number(proposal.tp || 0),
                sl: Number(proposal.sl || 0),
                sizeUsd: selectedSpotUsd,
            })
            : this.buildProposalCardText({
                symbol: String(proposal.symbol || "TOKEN"),
                timeframe: String(proposal.timeframe || "1H"),
                side: String(proposal.side || "LONG"),
                rr: Number.isFinite(rewardRisk) ? rewardRisk : null,
                confidencePct: Math.round(Number(proposal.confidence || 0) * 100),
                entry: Number(proposal.entry || 0),
                tp: Number(proposal.tp || 0),
                sl: Number(proposal.sl || 0),
                availableUsd: draft.availableUsd,
                marginPct: draft.collateralPct,
                marginUsd: draft.collateralUsd,
                leverage: draft.leverage,
                maxLeverage: draft.maxLeverage,
            });

        if (draft.messageId > 0) {
            try {
                await this.deleteMessage(chatId, draft.messageId);
            } catch {
            }
        }

        const sent = await this.sendMessage(chatId, text, {
            parseMode: "HTML",
            inlineKeyboard: draft.kind === "spot"
                ? this.buildSpotTradeKeyboard({
                    proposalId: draft.proposalId,
                    selectedUsd: selectedSpotUsd > 0 ? selectedSpotUsd : null,
                    openUrl: this.getAirificaProposalUrl({
                        marketQuery: draft.marketQuery || draft.baseTokenAddress || String(proposal.symbol || ""),
                        proposal,
                        sizeUsd: selectedSpotUsd,
                        venue: "jupiter",
                    }),
                })
                : this.buildPacificaTradeKeyboard({
                    proposalId: draft.proposalId,
                    marginPct: draft.collateralPct,
                    leverage: draft.leverage,
                    maxLeverage: draft.maxLeverage,
                }),
        });

        const nextDraft: TelegramProposalDraft = {
            ...draft,
            messageId: Number(sent?.message_id || 0),
        };
        this.proposalDrafts.set(this.getDraftKey(chatId, draft.proposalId), nextDraft);
        return nextDraft;
    }

    private async getLinkStatus(chatId: string) {
        return await this.internalApi<any>("/api/airi3/telegram/internal/link/status", {
            method: "POST",
            body: JSON.stringify({ chatId }),
        });
    }

    private buildHomeKeyboard(linked: boolean, alertsEnabled = true, conversationalEnabled = true) {
        const keyboard: Array<Array<TelegramInlineButton>> = [];
        const connectWebUrl = this.getConnectWebUrl();
        const botUrl = this.getBotUrl();

        if (!linked && connectWebUrl) {
            keyboard.push([
                { text: "Link in Airifica", url: connectWebUrl },
            ]);
        } else if (!linked && botUrl) {
            keyboard.push([
                { text: "Open bot", url: botUrl },
            ]);
        }

        if (linked) {
            keyboard.push([
                { text: "Actions", callback_data: "nav:actions" },
                { text: "Positions", callback_data: "nav:positions" },
                { text: "Help", callback_data: "nav:help" },
            ]);
            keyboard.push([
                { text: alertsEnabled ? "Alerts: on" : "Alerts: off", callback_data: alertsEnabled ? "alerts:off" : "alerts:on" },
                { text: conversationalEnabled ? "Chat: on" : "Chat: off", callback_data: conversationalEnabled ? "chat:off" : "chat:on" },
            ]);
            keyboard.push([
                { text: "Refresh", callback_data: "nav:home" },
                { text: "Unlink", callback_data: "nav:unlink" },
            ]);
        } else {
            keyboard.push([
                { text: "Help", callback_data: "nav:help" },
                { text: "Refresh", callback_data: "nav:home" },
            ]);
        }

        return keyboard;
    }

    private buildHelpKeyboard(linked: boolean) {
        return [
            [
                ...(linked ? [{ text: "Actions", callback_data: "nav:actions" }, { text: "Positions", callback_data: "nav:positions" }] : []),
                { text: "Home", callback_data: "nav:home" },
            ],
        ];
    }

    private buildActionsKeyboard() {
        return [
            [
                { text: "Chart", callback_data: "act:chart" },
                { text: "Price", callback_data: "act:price" },
            ],
            [
                { text: "Analysis", callback_data: "act:analysis" },
                { text: "Fundamentals", callback_data: "act:fundamentals" },
            ],
            [
                { text: "News", callback_data: "act:news" },
                { text: "Sentiment", callback_data: "act:sentiment" },
            ],
            [
                { text: "Trending", callback_data: "act:trending" },
                { text: "Listings", callback_data: "act:listings" },
            ],
            [
                { text: "Boosted", callback_data: "act:boosted" },
                { text: "Most mentioned", callback_data: "act:mentioned" },
            ],
            [
                { text: "Volume", callback_data: "act:volume" },
                { text: "Home", callback_data: "nav:home" },
            ],
        ];
    }

    private getPendingActionRequest(kind: string): PendingActionRequest | null {
        switch (kind) {
            case "chart":
                return { kind: "chart", promptPrefix: "Show the chart for", title: "Chart request" };
            case "price":
                return { kind: "price", promptPrefix: "What is the price of", title: "Price request" };
            case "analysis":
                return { kind: "analysis", promptPrefix: "Give me a technical analysis for", title: "Analysis request" };
            case "fundamentals":
                return { kind: "fundamentals", promptPrefix: "Give me the fundamentals for", title: "Fundamentals request" };
            case "news":
                return { kind: "news", promptPrefix: "Give me the latest news for", title: "News request" };
            case "sentiment":
                return { kind: "sentiment", promptPrefix: "What is the market sentiment for", title: "Sentiment request" };
            default:
                return null;
        }
    }

    private formatPendingActionTrace(pending: PendingActionRequest, input: string) {
        const value = shortText(input, 48);
        switch (pending.kind) {
            case "chart":
                return `Chart for ${value}`;
            case "price":
                return `Price for ${value}`;
            case "analysis":
                return `Analysis for ${value}`;
            case "fundamentals":
                return `Fundamentals for ${value}`;
            case "news":
                return `News for ${value}`;
            case "sentiment":
                return `Sentiment for ${value}`;
            default:
                return value;
        }
    }

    private getDirectActionTrace(kind: string) {
        switch (kind) {
            case "trending":
                return "Trending tokens";
            case "listings":
                return "New listings";
            case "boosted":
                return "Boosted tokens";
            case "mentioned":
                return "Most mentioned ticker";
            case "volume":
                return "Total market volume";
            default:
                return "";
        }
    }

    private async sendHome(chatId: string, messageId?: number) {
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
                "Control your Airifica account from Telegram.",
                "",
                `Wallet <code>${escapeHtml(shortWallet(link.walletAddress))}</code>`,
                summary ? `Equity <code>${escapeHtml(`${formatUsdCompact(summary.equityUsd)} USD`)}</code>` : null,
                summary ? `Available <code>${escapeHtml(`${formatUsdCompact(summary.availableUsd)} USD`)}</code>` : null,
                summary ? `Positions <code>${escapeHtml(summary.positionsCount)}</code>` : null,
                summary ? `Spot holdings <code>${escapeHtml(summary.onchainPositionsCount || 0)}</code>` : null,
                summary ? `PnL <code>${escapeHtml(`${summary.totalPnlUsd >= 0 ? "+" : ""}${formatUsdCompact(summary.totalPnlUsd)} USD`)}</code>` : null,
                summary && Number(summary.onchainValueUsd || 0) > 0
                    ? `Spot value <code>${escapeHtml(`${formatUsdCompact(summary.onchainValueUsd)} USD`)}</code>`
                    : null,
                summary?.latestTrade
                    ? `Last trade <code>${escapeHtml(`${summary.latestTrade.side} ${summary.latestTrade.symbol}`)}</code>`
                    : null,
                "",
                "<i>Use Actions for one-tap requests, Positions to manage open trades, and Help for the full guide.</i>",
            ].filter(Boolean) as string[]
            : [
                "This chat is not linked yet.",
                "Connect Telegram from Airifica to control positions and receive alerts here.",
                "Fallback: <code>/link CODE</code>",
            ];

        await this.sendOrEditMessage(chatId, messageId, compact([
            "<b>Airifica</b>",
            "",
            ...lines,
        ].join("\n")), {
            parseMode: "HTML",
            inlineKeyboard: this.buildHomeKeyboard(linked, Boolean(link?.alertsEnabled), Boolean(link?.conversationalEnabled)),
        });
    }

    private async renderHelp(chatId: string, messageId?: number) {
        let status: any = null;
        try {
            status = await this.getLinkStatus(chatId);
        } catch {
        }
        const linked = Boolean(status?.link);
        await this.sendOrEditMessage(chatId, messageId, compact([
            "<b>Help</b>",
            "",
            "<b>What this bot can do</b>",
            "• Answer market questions in natural language.",
            "• Show charts and trade setups from ticker or contract address.",
            "• Open Pacifica trades directly in Telegram.",
            "• Show open positions and close 25%, 50% or 100%.",
            "• Send trade alerts from Airifica into this chat.",
            "",
            "<b>How to use it</b>",
            "• Use <b>Actions</b> for guided requests.",
            "• Use <b>Positions</b> to inspect and close open trades.",
            "• Toggle <b>Alerts</b> and <b>Chat</b> from Home.",
            "• You can also just type normally, for example:",
            "<code>chart BTC</code>",
            "<code>price SOL</code>",
            "<code>analysis 2jvsWRkT17ofmv9pkW7ofqAFWSCNyJYdykJ7kPKbmoon</code>",
            "",
            linked
                ? "<i>Your wallet is linked and ready.</i>"
                : "<i>Link Telegram from Airifica first, or use /link CODE as fallback.</i>",
        ].join("\n")), {
            parseMode: "HTML",
            inlineKeyboard: this.buildHelpKeyboard(linked),
        });
    }

    private async renderActions(chatId: string, messageId?: number) {
        await this.sendOrEditMessage(chatId, messageId, compact([
            "<b>Actions</b>",
            "",
            "Choose a guided action below.",
            "",
            "Some actions will ask for a <b>ticker</b> or <b>contract address</b>.",
            "Others run immediately.",
        ].join("\n")), {
            parseMode: "HTML",
            inlineKeyboard: this.buildActionsKeyboard(),
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

    private async renderPositions(chatId: string, messageId?: number) {
        const payload = await this.internalApi<any>("/api/airi3/telegram/internal/positions", {
            method: "POST",
            body: JSON.stringify({ chatId }),
        });
        const overview = payload.overview || {};
        const account = overview.account || {};
        const positions = Array.isArray(overview.positions) ? overview.positions : [];
        const onchainPositions = Array.isArray(overview.onchainPositions) ? overview.onchainPositions : [];
        const lines = [
            `Wallet <code>${escapeHtml(shortWallet(payload.walletAddress))}</code>`,
            `Perp positions <code>${escapeHtml(positions.length)}</code>`,
            `Spot holdings <code>${escapeHtml(onchainPositions.length)}</code>`,
        ];

        if (positions.length) {
            lines.push("");
            lines.push("<b>Pacifica</b>");
            positions.slice(0, 8).forEach((position: any, index: number) => {
                lines.push(
                    `${index + 1}. <b>${escapeHtml(position.symbol)}</b> <i>${escapeHtml(position.side)}</i>`,
                    `<code>${escapeHtml(`amt ${formatNumberCompact(Number(position.amount || 0), 6)} | pnl ${formatUsdCompact(Number(position.unrealizedPnlUsd || 0))} USD`)}</code>`,
                );
            });
        } else {
            lines.push("", "<i>No open Pacifica positions</i>");
        }

        if (onchainPositions.length) {
            lines.push("", "<b>Onchain spot</b>");
            onchainPositions.slice(0, 8).forEach((position: any, index: number) => {
                lines.push(
                    `${index + 1}. <b>${escapeHtml(position.symbol)}</b>`,
                    `<code>${escapeHtml(`${formatNumberCompact(Number(position.quantity || 0), 6)} | ${formatUsdCompact(Number(position.valueUsd || 0))} USD`)}</code>`,
                );
            });
        } else {
            lines.push("", "<i>No open onchain positions</i>");
            lines.push(`Available <code>${escapeHtml(`${formatUsdCompact(Number(account.availableToSpend || 0))} USD`)}</code>`);
        }

        const keyboard = positions.slice(0, 6).map((position: any) => ([
            {
                text: `${position.symbol} ${position.side}`,
                callback_data: `pos:${position.symbol}:${position.side}`,
            },
        ]));

        await this.sendOrEditMessage(chatId, messageId, compact([
            "<b>Open positions</b>",
            "",
            ...lines,
        ].join("\n")), {
            parseMode: "HTML",
            inlineKeyboard: [
                ...keyboard,
                [
                    { text: "Refresh positions", callback_data: "nav:positions" },
                    { text: "Home", callback_data: "nav:home" },
                ],
            ],
        });
    }

    private async renderStatus(chatId: string, messageId?: number) {
        const status = await this.getLinkStatus(chatId);
        if (!status.link) {
            await this.sendHome(chatId, messageId);
            return;
        }
        const summary = status.summary || null;
        await this.sendOrEditMessage(chatId, messageId, compact([
            "<b>Account</b>",
            "",
            `Wallet <code>${escapeHtml(shortWallet(status.link.walletAddress))}</code>`,
            summary ? `Equity: <code>${escapeHtml(`${formatUsdCompact(summary.equityUsd)} USD`)}</code>` : null,
            summary ? `Available: <code>${escapeHtml(`${formatUsdCompact(summary.availableUsd)} USD`)}</code>` : null,
            summary ? `Withdrawable: <code>${escapeHtml(`${formatUsdCompact(summary.withdrawableUsd)} USD`)}</code>` : null,
            summary ? `Open positions: <code>${escapeHtml(summary.positionsCount)}</code>` : null,
            summary ? `Spot holdings: <code>${escapeHtml(summary.onchainPositionsCount || 0)}</code>` : null,
            summary ? `PnL: <code>${escapeHtml(`${summary.totalPnlUsd >= 0 ? "+" : ""}${formatUsdCompact(summary.totalPnlUsd)} USD`)}</code>` : null,
            summary && Number(summary.onchainValueUsd || 0) > 0
                ? `Spot value: <code>${escapeHtml(`${formatUsdCompact(summary.onchainValueUsd)} USD`)}</code>`
                : null,
            summary?.latestTrade
                ? `Last trade: <code>${escapeHtml(`${summary.latestTrade.side} ${summary.latestTrade.symbol}${summary.latestTrade.orderId ? ` (${summary.latestTrade.orderId})` : ""}`)}</code>`
                : "Last trade: <i>none</i>",
            `Alerts: <code>${escapeHtml(status.link.alertsEnabled ? "on" : "off")}</code>`,
            `Conversation: <code>${escapeHtml(status.link.conversationalEnabled ? "on" : "off")}</code>`,
        ].filter(Boolean).join("\n")), {
            parseMode: "HTML",
            inlineKeyboard: [[
                { text: "Positions", callback_data: "nav:positions" },
                { text: "Actions", callback_data: "nav:actions" },
                { text: "Home", callback_data: "nav:home" },
            ]],
        });
    }

    private formatActionError(error: any) {
        const payload = error?.payload && typeof error.payload === "object" ? error.payload : null;
        const rawError = String(payload?.error || error?.message || "Action failed").trim();
        const rawHint = String(payload?.hint || "").trim();
        if (/requires at least .* usd notional/i.test(rawError) || /too small for lot/i.test(rawError)) {
            const detail = rawHint || rawError;
            return compact([
                "<b>Trade not opened</b>",
                "",
                "<i>Selected size is too small for this market.</i>",
                `<code>${escapeHtml(detail)}</code>`,
                "",
                "Increase <b>Collateral</b>, raise <b>Leverage</b>, or use a larger preset before pressing <b>Execute</b> again.",
            ].join("\n"));
        }

        return compact([
            "<b>Action failed</b>",
            "",
            `<code>${escapeHtml(rawError)}</code>`,
            rawHint ? `<i>${escapeHtml(rawHint)}</i>` : null,
        ].filter(Boolean).join("\n"));
    }

    private async renderPositionDetail(chatId: string, symbol: string, side: string, messageId?: number) {
        const payload = await this.internalApi<any>("/api/airi3/telegram/internal/positions", {
            method: "POST",
            body: JSON.stringify({ chatId }),
        });
        const overview = payload.overview || {};
        const account = overview.account || {};
        const positions = Array.isArray(overview.positions) ? overview.positions : [];
        const target = positions.find((position: any) => String(position.symbol) === symbol && String(position.side) === side);
        if (!target) {
            if (messageId && Number.isFinite(messageId) && messageId > 0) {
                await this.editMessageText(chatId, messageId, "Position no longer open.", {
                    inlineKeyboard: [[
                        { text: "Positions", callback_data: "nav:positions" },
                        { text: "Home", callback_data: "nav:home" },
                    ]],
                });
                return;
            }
            await this.sendMessage(chatId, "Position no longer open.", {
                inlineKeyboard: [[
                    { text: "Positions", callback_data: "nav:positions" },
                    { text: "Home", callback_data: "nav:home" },
                ]],
            });
            return;
        }

        const text = compact([
            `<b>${escapeHtml(`${target.symbol} ${target.side}`)}</b>`,
            `<pre>Amount        ${escapeHtml(formatNumberCompact(Number(target.amount || 0), 6))}
Entry         ${escapeHtml(formatNumberCompact(Number(target.entryPrice || 0), 6))}
Mark          ${escapeHtml(formatNumberCompact(Number(target.markPrice || 0), 6))}
PnL           ${escapeHtml(`${Number(target.unrealizedPnlUsd || 0) >= 0 ? "+" : ""}${formatUsdCompact(Number(target.unrealizedPnlUsd || 0))} USD (${formatNumberCompact(Number(target.unrealizedPnlPct || 0), 2)}%)`)}
Notional      ${escapeHtml(`${formatUsdCompact(Number(target.notionalUsd || 0))} USD`)}
Margin        ${escapeHtml(`${formatUsdCompact(Number(target.margin || 0))} USD`)}</pre>`,
            target.takeProfitPrice ? `<b>TP</b> <code>${escapeHtml(formatNumberCompact(Number(target.takeProfitPrice || 0), 6))}</code>` : null,
            target.stopLossPrice ? `<b>SL</b> <code>${escapeHtml(formatNumberCompact(Number(target.stopLossPrice || 0), 6))}</code>` : null,
            target.liquidationPrice ? `<b>Liq</b> <code>${escapeHtml(formatNumberCompact(Number(target.liquidationPrice || 0), 6))}</code>` : null,
            `<i>Available</i> <code>${escapeHtml(`${formatUsdCompact(Number(account.availableToSpend || 0))} USD`)}</code>`,
        ].filter(Boolean).join("\n"));

        const keyboard = [
            [
                { text: "Close 25%", callback_data: `pc:${symbol}:${side}:25` },
                { text: "Close 50%", callback_data: `pc:${symbol}:${side}:50` },
                { text: "Close 100%", callback_data: `pc:${symbol}:${side}:100` },
            ],
            [
                { text: "Refresh", callback_data: `pos:${symbol}:${side}` },
                { text: "Positions", callback_data: "nav:positions" },
                { text: "Home", callback_data: "nav:home" },
            ],
        ];

        if (messageId && Number.isFinite(messageId) && messageId > 0) {
            await this.editMessageText(chatId, messageId, text, {
                parseMode: "HTML",
                inlineKeyboard: keyboard,
            });
            return;
        }

        await this.sendMessage(chatId, text, {
            parseMode: "HTML",
            inlineKeyboard: keyboard,
        });
    }

    private async sendProposalCard(chatId: string, sourceText: string, proposal: any) {
        const prepared = await this.internalApi<any>("/api/airi3/telegram/internal/proposals/prepare", {
            method: "POST",
            body: JSON.stringify({ chatId, sourceText, proposal }),
        });

        if (prepared.kind === "pacifica") {
            const maxLeverage = Math.max(1, Number(prepared.maxLeverage || 1));
            const selectedPct = 10;
            const selectedLeverage = 1;
            const proposalData = prepared.proposal || {};
            const draft: TelegramProposalDraft = {
                kind: "pacifica",
                chatId,
                proposalId: Number(prepared.proposalId),
                messageId: 0,
                availableUsd: Number(prepared.availableUsd || 0),
                maxLeverage,
                leverage: selectedLeverage,
                collateralPct: selectedPct,
                collateralUsd: null,
                proposal: proposalData,
            };
            await this.replaceProposalCard(chatId, draft);
            return;
        }

        if (prepared.kind === "spot") {
            const proposalData = prepared.proposal || {};
            const market = prepared.market || {};
            const draft: TelegramProposalDraft = {
                kind: "spot",
                chatId,
                proposalId: Number(prepared.proposalId),
                messageId: 0,
                availableUsd: Number(prepared.availableUsd || 0),
                maxLeverage: 1,
                leverage: 1,
                collateralPct: 25,
                collateralUsd: null,
                baseTokenAddress: market.baseTokenAddress || null,
                marketQuery: market.requestQuery || market.baseTokenAddress || proposalData.symbol || null,
                proposal: proposalData,
            };
            await this.replaceProposalCard(chatId, draft);
            return;
        }

        const proposalData = prepared.proposal || {};
        await this.sendMessage(chatId, compact([
            `$${proposalData.symbol || prepared.market?.symbol || "TOKEN"} ${proposalData.timeframe || "1H"} | ${proposalData.side || "LONG"}`,
            `Entry: ${formatNumberCompact(Number(proposalData.entry || 0), 6)}`,
            `TP: ${formatNumberCompact(Number(proposalData.tp || 0), 6)}`,
            `SL: ${formatNumberCompact(Number(proposalData.sl || 0), 6)}`,
            "",
            "This market is informative only right now.",
        ].join("\n")), {
            inlineKeyboard: this.buildHomeKeyboard(true),
        });
    }

    private async handleCommand(chatId: string, userId: string, username: string | null, firstName: string | null, text: string) {
        const parsed = this.parseCommand(text);
        if (!parsed)
            return false;

        await this.trackEvent(chatId, "telegram_command", parsed.command);

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
                inlineKeyboard: this.buildHomeKeyboard(true, Boolean(linkResult.link.alertsEnabled), Boolean(linkResult.link.conversationalEnabled)),
            });
            return true;
            }

            await this.sendHome(chatId);
            return true;
        }

        if (parsed.command === "help" || parsed.command === "menu") {
            await this.renderHelp(chatId);
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
                inlineKeyboard: this.buildHomeKeyboard(true, Boolean(linkResult.link.alertsEnabled), Boolean(linkResult.link.conversationalEnabled)),
            });
            return true;
        }

        if (parsed.command === "status") {
            await this.renderStatus(chatId);
            return true;
        }

        if (parsed.command === "account" || parsed.command === "pnl") {
            await this.renderStatus(chatId);
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
                await this.sendMessage(chatId, "Use the close buttons inside Positions.", {
                    inlineKeyboard: [[
                        { text: "Open positions", callback_data: "nav:positions" },
                        { text: "Home", callback_data: "nav:home" },
                    ]],
                });
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

        if (parsed.command === "actions") {
            await this.renderActions(chatId);
            return true;
        }

        return false;
    }

    private async handleConversationalMessage(chatId: string, text: string) {
        try {
            const pendingInput = this.pendingCollateralInputs.get(chatId);
            if (pendingInput) {
                const numeric = Number(String(text).replace(",", ".").trim());
                if (Number.isFinite(numeric) && numeric > 0) {
                    const snapshot = await this.internalApi<any>(`/api/airi3/telegram/internal/proposals/${pendingInput.proposalId}`, {
                        method: "POST",
                        body: JSON.stringify({ chatId }),
                    });
                    const proposal = snapshot.proposal?.data || {};
                    const draftKind: "pacifica" | "spot" = snapshot.proposal?.executionVenue === "jupiter" ? "spot" : "pacifica";
                    const maxLeverage = Math.max(1, Number(snapshot.proposal?.maxLeverage || 1));
                    const existingDraft = this.proposalDrafts.get(this.getDraftKey(chatId, pendingInput.proposalId));
                    const leverage = draftKind === "spot" ? 1 : Math.max(1, Number(existingDraft?.leverage || 1));
                    const availableUsd = Number(snapshot.availableUsd || existingDraft?.availableUsd || 0);
                    const collateralUsd = draftKind === "spot" ? numeric : Math.min(availableUsd, numeric);
                    const messageId = Number(existingDraft?.messageId || 0);
                    const nextDraft = {
                        kind: draftKind,
                        chatId,
                        proposalId: pendingInput.proposalId,
                        messageId,
                        availableUsd,
                        maxLeverage,
                        leverage,
                        collateralPct: null,
                        collateralUsd,
                        baseTokenAddress: snapshot.proposal?.baseTokenAddress || existingDraft?.baseTokenAddress || null,
                        marketQuery: existingDraft?.marketQuery || snapshot.proposal?.baseTokenAddress || proposal.symbol || null,
                        proposal,
                    };
                    this.proposalDrafts.set(this.getDraftKey(chatId, pendingInput.proposalId), nextDraft);
                    this.pendingCollateralInputs.delete(chatId);

                    await this.replaceProposalCard(chatId, nextDraft);

                    await this.sendMessage(chatId, `${draftKind === "spot" ? "Budget" : "Collateral"} updated to ${formatUsdCompact(collateralUsd)} USD.`, {
                        inlineKeyboard: [[
                            { text: "Back to proposal", callback_data: `tgp:r:${pendingInput.proposalId}` },
                        ]],
                    });
                    return;
                }

                await this.sendMessage(chatId, "Expected an amount in USD. Example: 12.5", {
                    inlineKeyboard: [[
                        { text: "Back to proposal", callback_data: `tgp:r:${pendingInput.proposalId}` },
                    ]],
                });
                return;
            }

            const pendingAction = this.pendingActionInputs.get(chatId);
            if (pendingAction) {
                this.pendingActionInputs.delete(chatId);
                await this.trackEvent(chatId, "telegram_action_prompt", pendingAction.kind);
                await this.sendActionTrace(chatId, this.formatPendingActionTrace(pendingAction, text));
                await this.handleConversationalMessage(chatId, `${pendingAction.promptPrefix} ${text}`);
                return;
            }

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
                const replyImage = String(response?.message?.image || "").trim();
                const replyText = String(response?.message?.text || "").trim();
                const proposal = response?.message?.proposal || null;
                if (replyText)
                    await this.sendMessage(chatId, replyText);
                if (replyImage)
                    await this.sendPhoto(chatId, replyImage);
                if (proposal)
                    await this.sendProposalCard(chatId, text, proposal);
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
        const messageId = Number(callback.message?.message_id || 0);
        const data = String(callback.data || "");
        if (!chatId || !data || (chatType && chatType !== "private"))
            return;

        try {
            if (data === "nav:home") {
                await this.answerCallbackQuery(callback.id, "Up to date");
                await this.sendHome(chatId, messageId);
                return;
            }

            if (data === "nav:positions") {
                await this.answerCallbackQuery(callback.id, "Updated");
                await this.renderPositions(chatId, messageId);
                return;
            }

            if (data === "nav:status") {
                await this.answerCallbackQuery(callback.id, "Updated");
                await this.renderStatus(chatId, messageId);
                return;
            }

            if (data === "nav:help") {
                await this.answerCallbackQuery(callback.id);
                await this.renderHelp(chatId, messageId);
                return;
            }

            if (data === "nav:actions") {
                await this.answerCallbackQuery(callback.id);
                await this.renderActions(chatId, messageId);
                return;
            }

            if (data === "nav:unlink") {
                await this.internalApi("/api/airi3/telegram/internal/unlink", {
                    method: "POST",
                    body: JSON.stringify({ chatId }),
                });
                await this.answerCallbackQuery(callback.id, "Telegram unlinked");
                await this.sendHome(chatId, messageId);
                return;
            }

            if (data === "alerts:on" || data === "alerts:off") {
                const enabled = data === "alerts:on";
                await this.internalApi("/api/airi3/telegram/internal/alerts/toggle", {
                    method: "POST",
                    body: JSON.stringify({ chatId, enabled }),
                });
                await this.answerCallbackQuery(callback.id, enabled ? "Alerts enabled" : "Alerts disabled");
                await this.sendHome(chatId, messageId);
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
                await this.sendHome(chatId, messageId);
                return;
            }

            if (data.startsWith("act:")) {
                const kind = data.slice(4);
                await this.trackEvent(chatId, "telegram_action", `act_${kind}`);
                const pending = this.getPendingActionRequest(kind);
                if (pending) {
                    this.pendingActionInputs.set(chatId, pending);
                    await this.answerCallbackQuery(callback.id, "Send ticker or contract address");
                    await this.sendOrEditMessage(chatId, messageId, compact([
                        `<b>${escapeHtml(pending.title)}</b>`,
                        "",
                        "Send a <b>ticker</b> or <b>contract address</b> as your next message.",
                        "",
                        "<i>Examples</i>",
                        "<code>BTC</code>",
                        "<code>SOL</code>",
                        "<code>2jvsWRkT17ofmv9pkW7ofqAFWSCNyJYdykJ7kPKbmoon</code>",
                    ].join("\n")), {
                        parseMode: "HTML",
                        inlineKeyboard: [[
                            { text: "Actions", callback_data: "nav:actions" },
                            { text: "Home", callback_data: "nav:home" },
                        ]],
                    });
                    return;
                }

                const directPrompt = kind === "trending"
                    ? "Show me the trending tokens right now."
                    : kind === "listings"
                        ? "Show me the new token listings right now."
                        : kind === "boosted"
                            ? "Show me the boosted tokens right now."
                            : kind === "mentioned"
                                ? "What is the most mentioned ticker right now?"
                                : kind === "volume"
                                    ? "What is the total market volume right now?"
                                    : "";
                if (directPrompt) {
                    await this.answerCallbackQuery(callback.id, "Running");
                    await this.sendActionTrace(chatId, this.getDirectActionTrace(kind));
                    await this.handleConversationalMessage(chatId, directPrompt);
                    return;
                }
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
                await this.renderPositions(chatId, messageId);
                return;
            }

            if (data.startsWith("pos:")) {
                const [, symbol, side] = data.split(":");
                await this.trackEvent(chatId, "telegram_action", "position_detail");
                await this.answerCallbackQuery(callback.id);
                await this.renderPositionDetail(chatId, symbol, side, messageId);
                return;
            }

            if (data.startsWith("pc:")) {
                const [, symbol, side, pctRaw] = data.split(":");
                await this.trackEvent(chatId, "telegram_action", `position_close_${pctRaw || "custom"}`);
                const pct = Math.min(100, Math.max(1, Number(pctRaw || 100)));
                const payload = await this.internalApi<any>("/api/airi3/telegram/internal/positions", {
                    method: "POST",
                    body: JSON.stringify({ chatId }),
                });
                const positions = Array.isArray(payload.overview?.positions) ? payload.overview.positions : [];
                const target = positions.find((position: any) => String(position.symbol) === symbol && String(position.side) === side);
                if (!target) {
                    await this.answerCallbackQuery(callback.id, "Position not found");
                    await this.renderPositions(chatId, messageId);
                    return;
                }
                const amount = Number(target.amount || 0) * (pct / 100);
                const result = await this.internalApi<any>("/api/airi3/telegram/internal/close", {
                    method: "POST",
                    body: JSON.stringify({
                        chatId,
                        symbol,
                        side,
                        amount,
                    }),
                });
                await this.answerCallbackQuery(callback.id, `Closed ${pct}%`);
                await this.renderPositions(chatId, messageId);
                return;
            }

            if (data.startsWith("tgp:")) {
                const [, action, proposalIdRaw, firstRaw, secondRaw] = data.split(":");
                await this.trackEvent(chatId, "telegram_action", `proposal_${action}`);
                const proposalId = Number(proposalIdRaw);
                if (!Number.isFinite(proposalId)) {
                    await this.answerCallbackQuery(callback.id, "Invalid proposal");
                    return;
                }

                const draftKey = this.getDraftKey(chatId, proposalId);
                const snapshot = await this.internalApi<any>(`/api/airi3/telegram/internal/proposals/${proposalId}`, {
                    method: "POST",
                    body: JSON.stringify({ chatId }),
                });
                const proposal = snapshot.proposal?.data || {};
                const draftKind: "pacifica" | "spot" = snapshot.proposal?.executionVenue === "jupiter" ? "spot" : "pacifica";
                const maxLeverage = Math.max(1, Number(snapshot.proposal?.maxLeverage || 1));
                const existingDraft = this.proposalDrafts.get(draftKey);
                const availableUsd = Number(snapshot.availableUsd || existingDraft?.availableUsd || 0);
                let leverage = draftKind === "spot"
                    ? 1
                    : Math.min(maxLeverage, Math.max(1, Number(existingDraft?.leverage || firstRaw || 1)));
                let collateralPct = existingDraft?.collateralPct ?? (draftKind === "spot" ? 25 : 10);
                let collateralUsd = existingDraft?.collateralUsd ?? null;

                if (action === "x") {
                    if (draftKind === "spot") {
                        await this.answerCallbackQuery(callback.id, "Open in Airifica to sign the Jupiter swap");
                        return;
                    }
                    if (existingDraft?.collateralUsd != null) {
                        collateralUsd = Math.min(availableUsd, Math.max(0, Number(existingDraft.collateralUsd)));
                    } else {
                        collateralPct = Math.min(100, Math.max(1, Number(existingDraft?.collateralPct || 10)));
                    }
                    const result = await this.internalApi<any>(`/api/airi3/telegram/internal/proposals/${proposalId}/approve`, {
                        method: "POST",
                        body: JSON.stringify({
                            chatId,
                            ...(collateralUsd != null ? { collateral_usd: collateralUsd } : { collateral_pct: collateralPct }),
                            leverage,
                        }),
                    });
                    await this.answerCallbackQuery(callback.id, "Trade executed");
                    const successText = compact([
                        "<b>Trade opened</b>",
                        "",
                        `<code>${escapeHtml(`${result.side} ${result.symbol}`)}</code>`,
                        `<i>Collateral</i> <code>${escapeHtml(`${formatUsdCompact(result.marginUsd)} USD`)}</code>`,
                        `<i>Leverage</i> <code>${escapeHtml(`${result.leverage}x`)}</code>`,
                        result.orderId ? `<i>Order</i> <code>${escapeHtml(result.orderId)}</code>` : null,
                    ].filter(Boolean).join("\n"));
                    await this.sendOrEditMessage(chatId, messageId, successText, {
                        parseMode: "HTML",
                        inlineKeyboard: [[
                            { text: "Positions", callback_data: "nav:positions" },
                            { text: "Home", callback_data: "nav:home" },
                        ]],
                    });
                    this.proposalDrafts.delete(draftKey);
                    this.pendingCollateralInputs.delete(chatId);
                    return;
                }

                if (action === "s") {
                    this.pendingCollateralInputs.set(chatId, { proposalId });
                    await this.answerCallbackQuery(callback.id, draftKind === "spot"
                        ? "Send the budget amount in USD as your next message"
                        : "Send the collateral amount in USD as your next message");
                    await this.sendMessage(chatId, draftKind === "spot"
                        ? "Send the budget amount in USD as your next message. Example: 25"
                        : "Send the collateral amount in USD as your next message. Example: 12.5");
                    return;
                }

                if (action === "p") {
                    collateralPct = Math.min(draftKind === "spot" ? 1000 : 100, Math.max(1, Number(firstRaw || (draftKind === "spot" ? 25 : 10))));
                    collateralUsd = null;
                }
                if (action === "l") {
                    if (draftKind === "spot") {
                        await this.answerCallbackQuery(callback.id, "Leverage is not available for spot swaps");
                        return;
                    }
                    leverage = Math.min(maxLeverage, Math.max(1, Number(firstRaw || 1)));
                }
                if (action === "r") {
                    leverage = draftKind === "spot" ? 1 : Math.min(maxLeverage, Math.max(1, Number(existingDraft?.leverage || 1)));
                }

                const nextDraft = {
                    kind: draftKind,
                    chatId,
                    proposalId,
                    messageId: Number.isFinite(messageId) && messageId > 0 ? messageId : Number(existingDraft?.messageId || 0),
                    availableUsd,
                    maxLeverage,
                    leverage,
                    collateralPct,
                    collateralUsd,
                    baseTokenAddress: snapshot.proposal?.baseTokenAddress || existingDraft?.baseTokenAddress || null,
                    marketQuery: existingDraft?.marketQuery || snapshot.proposal?.baseTokenAddress || proposal.symbol || null,
                    proposal,
                };
                this.proposalDrafts.set(draftKey, nextDraft);
                await this.answerCallbackQuery(callback.id);
                await this.replaceProposalCard(chatId, nextDraft);
                return;
            }

            await this.answerCallbackQuery(callback.id, "Unsupported action.");
        } catch (error: any) {
            if (/message is not modified/i.test(describeError(error))) {
                await this.answerCallbackQuery(callback.id, "Up to date");
                return;
            }
            const brief = shortText(error?.payload?.error || error?.message || "Action failed", 120);
            await this.answerCallbackQuery(callback.id, brief);
            await this.sendMessage(chatId, this.formatActionError(error), {
                parseMode: "HTML",
                inlineKeyboard: [[
                    { text: "Home", callback_data: "nav:home" },
                    { text: "Positions", callback_data: "nav:positions" },
                ]],
            });
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
                { command: "unlink", description: "Unlink this Telegram chat from Airifica" },
            ]);
        } catch (error) {
            elizaLogger.warn(`[client-telegram-airifica] setMyCommands skipped: ${describeError(error)}`);
        }

        try {
            await this.sendRuntimeHeartbeat();
        } catch (error) {
            elizaLogger.warn(`[client-telegram-airifica] heartbeat skipped: ${describeError(error)}`);
        }
        this.heartbeatTimer = setInterval(() => {
            void this.sendRuntimeHeartbeat().catch((error) => {
                elizaLogger.warn(`[client-telegram-airifica] heartbeat failed: ${describeError(error)}`);
            });
        }, 60_000);
        this.pollPromise = this.pollLoop();
        this.alertPromise = this.alertLoop();
        elizaLogger.success("[client-telegram-airifica] Telegram bot started");
        return true;
    }

    public async stop(): Promise<void> {
        this.running = false;
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        await Promise.allSettled([
            this.pollPromise,
            this.alertPromise,
        ]);
    }
}
