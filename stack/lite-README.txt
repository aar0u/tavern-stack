SillyTavern（精简版：只有 ST，聊天连主机上的网关，没有生图）

1. 需要 Docker 和 Docker Compose。
2. 在这个目录里运行：
       docker compose up -d
   第一次会下载镜像、安装扩展，要等一两分钟。
3. 浏览器打开 http://localhost:8000 （局域网里其他设备用这台机器的地址:8000）。
4. 聊天用的是远端的 gateway（那台机器要开着，并且网关的 8789 端口可访问）。地址写在
   seed/settings.json 的 oai_settings.custom_url 里，换地址就改它，然后 docker compose up -d --force-recreate。
5. 这里没有生图：悬浮面板里没有画图按钮，只有"总结"等。
6. 数据都在 ./data 里（聊天、设置）；要备份就备份这个目录。
7. 改了 seed/ 里的文件后重新应用：
       docker compose up -d --force-recreate
   注意 seed 每次都会覆盖界面里改过的同名设置。
