# EasyWork skills

所有 EasyWork 技能都存放在此目录树中。

```text
skill/
├── built-in/           # 随应用提供的技能
├── guests/<guest-id>/  # 访客上传，关闭会话时可清理
└── users/<user-id>/    # 登录用户的私有技能
```

一个技能可以是包含 `SKILL.md` 的文件夹、单个 Markdown 文件，或 ZIP 包。上传时网关会清理路径并解压到当前身份的独立目录。对话只会加载用户在输入框下方明确选择的技能。

