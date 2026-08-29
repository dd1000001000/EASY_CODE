# Exchange matching server (Homework 4)
FROM python:3.13-slim

WORKDIR /app

# The server is pure Python standard library: nothing to install.
COPY server.py /app/server.py

# The matching engine listens on TCP port 12345.
EXPOSE 12345

# In-memory state only: restarting the container resets the exchange.
CMD ["python", "server.py"]
