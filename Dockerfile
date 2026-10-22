FROM python:3.12-slim

# ffmpeg: needed by yt-dlp for some formats / muxing
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY index.html ./index.html
COPY server/ ./server/

ENV PYTHONUNBUFFERED=1
WORKDIR /app/server
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
