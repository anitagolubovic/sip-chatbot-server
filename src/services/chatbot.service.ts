import OpenAI from "openai";
import { buildSystemPrompt, buildUserMessage } from "../prompts/template";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ServiceResponse = {
  success: boolean;
  question: string;
  answer?: string;
  error?: string;
  timestamp: string;
};

class ChatbotService {
  private readonly openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  async analyzeQuestion(
    question: string,
    conversationHistory: ChatMessage[] = [],
    context = "",
  ): Promise<ServiceResponse> {
    const normalizedQuestion = buildUserMessage(question);
    const model = process.env.OPENAI_MODEL;
    if (!model) {
      throw new Error("OPENAI_MODEL environment variable is required.");
    }

    const response = await this.openai.responses.create({
      model,
      instructions: buildSystemPrompt(context),
      input: [
        ...conversationHistory.map(({ role, content }) => ({ role, content })),
        { role: "user" as const, content: normalizedQuestion },
      ],
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
