FROM oven/bun:1.4.0

WORKDIR /app

# Copy package files
COPY package.json bun.lockb ./
COPY packages ./packages
COPY pins.json ./

# Install dependencies
RUN bun install --frozen-lockfile

# Set working directory to bot
WORKDIR /app/packages/bot

# Copy .env file (make sure it exists before building)
COPY packages/bot/.env .env

# Run the bot session
CMD ["bun", "run", "session"]
