#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

class HelloWorldMCPServer {
  constructor() {
    this.server = new Server(
      {
        name: 'hello-world-mcp-server',
        version: '0.0.1',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
  }

  setupToolHandlers() {
    // Обработчик для получения списка доступных тулз
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'hello_world',
            description: 'Простая тулза, которая возвращает приветствие',
            inputSchema: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'Имя для приветствия (опционально)',
                },
              },
            },
          },
        ],
      };
    });

    // Обработчик для выполнения тулз
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === 'hello_world') {
        const name = request.params.arguments?.name || 'Мир';
        return {
          content: [
            {
              type: 'text',
              text: `Привет, ${name}! Это работает! 🎉`,
            },
          ],
        };
      }

      throw new Error(`Неизвестная тулза: ${request.params.name}`);
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Hello World MCP Server запущен и готов к работе!');
  }
}

// Запуск сервера
const server = new HelloWorldMCPServer();
server.run().catch(console.error);
