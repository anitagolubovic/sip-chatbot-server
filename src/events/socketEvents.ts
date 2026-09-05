import { isEmpty } from "../helper";
import ChatbotService, { ChatMessage } from "../services/chatbot.service";
import type { Server, Socket } from "socket.io";

interface SendMessageData {
  question: string;
  conversationHistory?: ChatMessage[];
  context?: string;
  category?: string;
}

const chatbotService = new ChatbotService();

export function initializeSocketEvents(io: Server): void {
  io.on("connection", (socket: Socket) => {
    console.log(`New client connected: ${socket.id}`);

    socket.emit("connected", {
      message: "Welcome to Chatbot Server",
      serverId: socket.id,
      timestamp: new Date().toISOString(),
    });

    socket.on("sendMessage", async (data: SendMessageData) => {
      try {
        const { question, conversationHistory, context, category } = data;

        if (isEmpty(question)) {
          socket.emit("error", {
            message: "Question cannot be empty",
            timestamp: new Date().toISOString(),
          });
          return;
        }

        socket.emit("botTyping", {
          status: true,
          timestamp: new Date().toISOString(),
          message: "Chatbot is typing...",
        });

        const response = await chatbotService.analyzeQuestion(
          question,
          conversationHistory,
          context,
          category,
        );

        socket.emit("botTyping", {
          status: false,
          timestamp: new Date().toISOString(),
        });

        socket.emit("receiveMessage", {
          question: response.question,
          answer: response.answer,
          success: response.success,
          timestamp: response.timestamp,
        });
      } catch (error: unknown) {
        socket.emit("error", {
          message: "An error occurred while processing your question",
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        });
      }
    });

    socket.on("error", (error: Error) => {
      console.error(`Socket error from ${socket.id}:`, error);
    });
  });
}
