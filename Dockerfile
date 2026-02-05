# Dockerfile for C2PA Viewer on Fly.io

FROM python:3.12-slim

# Set working directory
WORKDIR /app

# Install system dependencies for Pillow and c2pa
RUN apt-get update && apt-get install -y \
    gcc \
    libjpeg-dev \
    zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

# Install uv
RUN pip install uv

# Copy dependency files AND README
COPY pyproject.toml uv.lock README.md ./

# Install dependencies using uv
RUN uv sync --frozen --no-dev

# Copy application files
COPY . .

# Expose port
EXPOSE 8080

# Run the FastAPI application
CMD [".venv/bin/uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080"]
