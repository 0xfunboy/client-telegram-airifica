import { elizaLogger } from "@elizaos/core";
import type { Client, IAgentRuntime } from "@elizaos/core";
import { TelegramAirificaClient } from "./telegramClient.ts";

export { TelegramAirificaClient } from "./telegramClient.ts";

export const TelegramAirificaClientInterface: Client = {
    start: async (runtime: IAgentRuntime) => {
        const client = new TelegramAirificaClient(runtime);
        const ok = await client.start();
        if (!ok) {
            elizaLogger.warn("[client-telegram-airifica] bot failed to start");
            return null;
        }
        return client;
    },
    stop: async (_runtime: IAgentRuntime) => {
        elizaLogger.warn("[client-telegram-airifica] stop called (no-op for now)");
    },
};

export default TelegramAirificaClientInterface;
