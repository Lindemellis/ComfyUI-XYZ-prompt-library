# 隔离 PLv4 样例与测试辅助

这些脚本不属于默认 pytest 离线测试入口。日常回归见 [V4 内部维护说明](../../prompt_library_v4/DEVELOPMENT.md#验证与后续边界)。t78/t79 只调用辅助函数并使用临时数据库，不操作个人库或已运行的实例。

| 脚本 | 用途和边界 |
|---|---|
| prepare_xyz_test_comfy.py | 向独立 root 复制代码，不复制个人凭据；本地 TagDB 以 SQLite backup 独立复制，已有非空测试库不替换 |
| start_xyz_test_comfy.ps1 | Windows 整合包布局的 XYZNodes-only 实例启动/重启/停止；默认 CPU、8190，停止前核验 PID/命令行 |
| seed_xyz_test_samples.py | 从本机隔离实例的旧实验 V4 原件转换到新 Folder 池库和 workflow；新目标存在则不覆盖 |
| update_xyz_pool_examples.py | 仅修整已转换的隔离副本并补池绑定示例；先备份，保留稳定 ID、关闭项和用户编辑 |

后两项是本机既有样例的维护工具，不是新安装的通用个人库迁移命令。V3 用户迁移使用 Library 的明确确认入口；早期 V4 数据迁移使用要求新目标的副本转换器。没有旧样例时不需要运行这些工具。

8190 是用户长期保留的验收实例，不能当一次性浏览器 fixture。不要为离线检查启动、停止或重置它。旧 Class-era browser scripts / 原型截图仅为本地历史遗留，不随本阶段发布，也不作为当前 Folder 模型入口。
