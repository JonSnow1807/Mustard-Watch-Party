FROM nginx:1.27-alpine

# iproute2 provides tc/netem; the qdisc is applied at runtime because the
# spec changes per scenario and NET_ADMIN is only granted by compose.
RUN apk add --no-cache iproute2

COPY nginx-stream.conf /etc/nginx/nginx.conf
COPY apply-netem /usr/local/bin/apply-netem
RUN chmod +x /usr/local/bin/apply-netem
