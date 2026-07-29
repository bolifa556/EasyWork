# 两台电脑的 Syncthing 规则

Syncthing 共享根目录可以分别是：

- 本机/笔记本：`D:\Project\107Comptetion`
- 台式机：`F:\Project\107Competition`

规则只使用相对路径，因此盘符和父目录拼写不同不会影响效果。

`stignore.shared` 会随项目同步，里面只忽略依赖、构建产物、日志和
`frpc.local.toml`。`data/`、`skill/`、`prompts/` 与源码没有被忽略，会继续共享。

Syncthing 的根 `.stignore` 是设备本地文件，通常不会同步。每台电脑首次使用时运行：

```powershell
powershell -ExecutionPolicy Bypass -File EasyWork\sync\install.ps1
```

`frp\start.cmd` 也会自动执行这一步。

同一账号的数据可以在两台机器之间同步，但不建议两台机器同时频繁修改同一聊天；
Syncthing 在并发写入时可能生成 conflict 文件。

