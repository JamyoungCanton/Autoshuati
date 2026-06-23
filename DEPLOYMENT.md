# Chaoxing 控制台部署

推荐给 2 核 2G 服务器使用 Docker Compose 部署。容器内会构建前端并用 Gunicorn 启动 Flask，访问同一个域名即可打开页面和调用 `/api`。

## 启动

```bash
docker compose up -d --build
```

默认监听服务器 `5000` 端口：

```text
http://服务器IP:5000
```

用户配置会保存在宿主机：

```text
./data/users/<device_id>/
```

## Nginx 反向代理

如果使用域名和 HTTPS，Nginx 可以反代到本机 `5000`：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## 2 核 2G 建议

- 保持 `1 worker + 4 threads`
- 同时运行任务建议限制在 1 个
- 建议开启 1G 到 2G swap
- 不要在生产环境使用 `npm run dev` 或 Flask debug 模式
