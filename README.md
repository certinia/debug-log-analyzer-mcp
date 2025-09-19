# LANA MCP Server

This is the Model Context Protocol (MCP) server for the LANA (Apex Log Analyzer) VS Code extension. It provides AI agents like GitHub Copilot with tools to analyze Salesforce Apex debug logs.

## Features

The MCP server provides three main tools:

1. **analyze_apex_log_performance** - Identifies the slowest running methods in a debug log
2. **get_apex_log_summary** - Provides a high-level summary of log execution
3. **find_performance_bottlenecks** - Detects CPU, database, and method performance issues

## Usage

The MCP server is automatically registered by the LANA VS Code extension. When the extension is installed, AI agents in VS Code can use these tools to analyze Apex logs.

### Example AI Prompts

- "Analyze this log file for slow methods"
- "What are the performance bottlenecks in this Apex execution?"
- "Summarize the database operations in this debug log"
- "Find methods taking more than 100ms"

## Development

### Prerequisites

- Node.js 18+
- pnpm package manager

### Building

```bash
pnpm install
pnpm run build
```

### Running Standalone

```bash
pnpm run start
```

### Development Mode

```bash
pnpm run dev  # Watch mode
```

## Architecture

- Built with TypeScript and the MCP SDK
- Uses the same `ApexLogParser` as the main LANA extension
- Runs as a standalone Node.js process
- Communicates via stdio transport

## Integration

The MCP server is automatically registered by the VS Code extension through:

1. `lana/package.json` - Declares the MCP server definition provider
2. `lana/src/mcp/LanaMcpProvider.ts` - Implements the provider
3. `lana/src/Context.ts` - Registers the provider on extension activation

## API Reference

See the [MCP Server Instructions](../.github/instructions/mcp-server.instructions.md) for detailed API documentation.
