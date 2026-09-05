import OpenAI from "openai";
import { buildSystemPrompt, buildUserMessage } from "../prompts/template";
import { countTokens } from "../preprocessing";
import { resolveCategory } from "../models/categories";
import { describeRetrieved, retrieve } from "./retrieval";
import { Maybe } from "../models/types";
import {
  buildRetrievalQuery,
  ChatMessage,
  trimHistory,
} from "./conversation";

export type { ChatMessage } from "./conversation";

export type ServiceResponse = {
  success: boolean;
  question: string;
  answer?: string;
  error?: string;
  timestamp: string;
};

/**
 * Potrosnja po pitanju. Uz stvarne brojeve modela ispisuje i lokalnu procenu,
 * da bi se videlo koliko od ulaza otpada na sistemski prompt a koliko na
 * podatke iz baze.
 */
function logTokenUsage(details: {
  question: string;
  model: string;
  context: string;
  instructions: string;
  history: ChatMessage[];
  answer: string;
  usage: OpenAI.Responses.ResponseUsage | undefined;
}): void {
  const { usage, model } = details;
  const promptTokens = countTokens(details.instructions, model);
  const contextTokens = countTokens(details.context, model);
  const historyTokens = details.history.reduce(
    (sum, message) => sum + countTokens(message.content, model),
    0,
  );

  console.log(
    `[tokeni] "${details.question}"\n` +
      `  ulaz    ${usage?.input_tokens ?? "?"}` +
      ` (kesirano ${usage?.input_tokens_details?.cached_tokens ?? 0})` +
      ` = prompt ${promptTokens - contextTokens} + kontekst ${contextTokens}` +
      ` + pitanje ${countTokens(details.question, model)}` +
      ` + istorija ${historyTokens} (${details.history.length} poruka)\n` +
      `  izlaz   ${usage?.output_tokens ?? "?"}` +
      ` (rezonovanje ${usage?.output_tokens_details?.reasoning_tokens ?? 0}` +
      `, odgovor ${countTokens(details.answer, model)})\n` +
      `  ukupno  ${usage?.total_tokens ?? "?"}`,
  );
}

class ChatbotService {
  private readonly openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  /**
   * Cinjenice iz baze za postavljeno pitanje. Kad baza nije dostupna, bot
   * nastavlja bez konteksta umesto da pukne.
   */
  private async retrieveContext(
    question: string,
    category: ReturnType<typeof resolveCategory>,
  ): Promise<string> {
    try {
      return describeRetrieved(await retrieve(question, category), category);
    } catch (error) {
      console.error(
        "[chatbot] Retrieval failed:",
        error instanceof Error ? error.message : error,
      );
      return "";
    }
  }

  async analyzeQuestion(
    question: string,
    conversationHistory: ChatMessage[] = [],
    context: string = "",
    category?: Maybe<string>,
  ): Promise<ServiceResponse> {
    const normalizedQuestion = buildUserMessage(question);
    const model = process.env.OPENAI_MODEL;
    if (!model) {
      throw new Error("OPENAI_MODEL environment variable is required.");
    }

    const selectedCategory = resolveCategory(category);
    // Modelu ide samo poslednjih nekoliko poruka; pretrazi ide pitanje
    // dopunjeno prethodnim kada se na njega oslanja.
    const history = trimHistory(conversationHistory, model);
    const retrieved = await this.retrieveContext(
      buildRetrievalQuery(normalizedQuestion, history, model),
      selectedCategory,
    );
    const fullContext = [retrieved, context].filter(Boolean).join("\n\n");

    const instructions = buildSystemPrompt(fullContext);
    const response = await this.openai.responses.create({
      model,
      instructions,
      input: [
        ...history,
        { role: "user" as const, content: normalizedQuestion },
      ],
    });

    logTokenUsage({
      question: normalizedQuestion,
      model,
      context: fullContext,
      instructions,
      history,
      answer: response.output_text,
      usage: response.usage,
    });

    return {
      success: true,
      question: normalizedQuestion,
      answer: response.output_text,
      timestamp: new Date().toISOString(),
    };
  }
}

export default ChatbotService;
