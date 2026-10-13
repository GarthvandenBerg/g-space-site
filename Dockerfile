FROM nginxinc/nginx-unprivileged:stable-alpine3.24

USER root
RUN apk update && apk upgrade --no-cache
USER 101

# Copy custom Nginx configuration
COPY nginx/default.conf /etc/nginx/conf.d/default.conf

# Copy web files from /web directory
COPY web/ /usr/share/nginx/html/

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]