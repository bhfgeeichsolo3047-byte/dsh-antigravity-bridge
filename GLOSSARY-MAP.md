# Glossary Map

## Contexts

- [dsh-agy-collab](./plugin/dsh-agy-collab/GLOSSARY.md): 本插件的三角色协作协议、临时工作台与 Host/Broker 桥接

## Relationships

- **plugin → broker**: 插件通过本地 HTTP（`127.0.0.1:18765`）与 Broker 通信；Broker 承载角色之间的消息，不承载状态。
- **plugin → antigravity**: 角色规则以文本模板形式分发到 `antigravity/`，由外部 Agent 侧加载。
