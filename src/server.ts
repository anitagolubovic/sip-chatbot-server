import "dotenv/config";
import express, { Application } from "express";
import cors from "cors";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import { initializeSocketEvents } from "./events/socketEvents";

const app: Application = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || "http://localhost:4200",
    methods: ["GET", "POST"],
  },
});

app.use(cors());

initializeSocketEvents(io);

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => {
  console.log(`Chatbot server: http://localhost:${port}`);
});

export { server, io };
