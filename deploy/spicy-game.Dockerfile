FROM python:3.12-slim

WORKDIR /app
COPY games/spicy-monopoly/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY games/spicy-monopoly ./

RUN mkdir -p /app/monopoly-games /app/monopoly-seen \
    && chown -R nobody:nogroup /app
USER nobody

EXPOSE 8069
CMD ["uvicorn", "monopoly_api:app", "--host", "0.0.0.0", "--port", "8069"]
