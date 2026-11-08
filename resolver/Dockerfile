FROM python:3.12-slim
# deno：yt-dlp 解析 YouTube 需要的 JavaScript 运行时
COPY --from=denoland/deno:bin-2.5.6 /deno /usr/local/bin/deno
RUN pip install --no-cache-dir "yt-dlp[default]"
WORKDIR /app
COPY app.py entrypoint.sh ./
RUN chmod +x entrypoint.sh
ENV PYTHONUNBUFFERED=1 PORT=8000 COOKIES_FILE=/cookies/cookies.txt
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/healthz',timeout=3)" || exit 1
ENTRYPOINT ["./entrypoint.sh"]
