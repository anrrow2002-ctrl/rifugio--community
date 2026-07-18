FROM python:3.13-slim
WORKDIR /app
COPY packages/mcp packages/mcp
RUN mkdir -p /app/data /app/private && useradd --system --uid 10001 rifugio && chown -R rifugio:rifugio /app
USER rifugio
EXPOSE 3456
CMD ["python3", "packages/mcp/server.py"]
