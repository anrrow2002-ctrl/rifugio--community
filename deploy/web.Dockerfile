FROM nginx:1.27-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY apps/web /usr/share/nginx/html
EXPOSE 80
