# dsh-agy-collab

本插件的领域语言：三个角色与它们之间唯一的共享状态载体。

## Language

**Planner**:
把原始需求拆成步骤、预估所需工具类型与 Executor 需派发的子 agent 数量、并写明「要达到什么目的」的角色。它不能审核自己的产物。
_Avoid_: 规划 agent, architect, designer, 拆解器

**Executor**:
唯一有写权限的角色。执行 Planner 下达的任务清单，并把执行过程留在 Workspace。
_Avoid_: 主 agent, main agent, worker, 执行者, 主控

**Reviewer**:
只读需求与产物、只判定「是否达到需求」的角色。它没有写通道，产出只有结论（通过 / 需修改）与问题清单。
_Avoid_: 审核 agent, checker, approver, 质检

**Workspace**:
随插件启动创建、会话结束时销毁的临时目录；六个子目录是三个角色之间唯一的共享状态载体。
_Avoid_: 临时文件夹, temp dir, workdir, 工作台文件夹
