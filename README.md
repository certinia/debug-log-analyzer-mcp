# 🛠️ LANA MCP Server

This is the Model Context Protocol (MCP) server for the LANA (Apex Log Analyzer) VS Code extension. It provides AI agents like GitHub Copilot with tools to analyze Salesforce Apex debug logs.

[Usage](#-usage "Go to usage guidelines") |
[Features](#-features "Go to Features") |
[Documentation](#-documentation "Go to Documentation") |
[Contributors](#%EF%B8%8F-contributors "Go to Contributors") |
[License](#-license "Go to License")

## 🚀 Features

The MCP server provides four main tools:

1. **analyze_apex_log_performance** - Identifies the slowest running methods in a debug log
2. **get_apex_log_summary** - Provides a high-level summary of log execution
3. **find_performance_bottlenecks** - Detects CPU, database, and method performance issues
4. **execute_anonymous** - Executes anonymous Apex code and retrieves the resulting debug log

## 💡 Usage

The MCP server is automatically registered by the LANA VS Code extension. When the extension is installed, AI agents in VS Code can use these tools to analyze Apex logs.

### Example AI Prompts

- "Analyze this log file for slow methods"
- "What are the performance bottlenecks in this Apex execution?"
- "Summarize the database operations in this debug log"
- "Find methods taking more than 100ms"

## 🏗️ Architecture

- Built with TypeScript and the MCP SDK
- Uses the same `ApexLogParser` as the main LANA extension
- Runs as a standalone Node.js process
- Communicates via stdio transport

## 🔌 Integration

The MCP server is automatically registered by the VS Code extension through:

1. `lana/package.json` - Declares the MCP server definition provider
2. `lana/src/mcp/LanaMcpProvider.ts` - Implements the provider
3. `lana/src/Context.ts` - Registers the provider on extension activation

## 📖 API Reference

See the [MCP Server Instructions](../.github/instructions/mcp-server.instructions.md) for detailed API documentation.

## 📚 Documentation

<!-- TODO: Update the 'User Guide & Docs' link to match the new mcp server page  -->

- [User Guide & Docs](https://certinia.github.io/debug-log-analyzer/)
- [Contribute](https://github.com/certinia/debug-log-analyzer-mcp/blob/main/CONTRIBUTING.md)
- [Develop](https://github.com/certinia/debug-log-analyzer-mcp/blob/main/DEVELOPING.md)

## ❤️ Contributors

Thanks to our amazing contributors!

<p align="center">
  <a href="https://github.com/certinia/debug-log-analyzer-mcp/graphs/contributors">
    <img src="https://contrib.rocks/image?repo=certinia/debug-log-analyzer-mcp&max=25" />
  </a>
</p>

## 📄 License

<p align="center">
Copyright &copy; Certinia Inc. All rights reserved.
</p>
<p align="center">
  <a href="https://opensource.org/licenses/BSD-3-Clause">
    <img src="https://img.shields.io/badge/License-BSD_3--Clause-blue.svg?style=flat-square"/>
  </a>
</p>
