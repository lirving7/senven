# JobPilot UI 第一阶段 · 移动端抽屉交互实测

基准地址：http://localhost:3000

| # | 检查项 | 期望 | 实测 | 结果 |
|---|---|---|---|---|
| 1 | 375 初始：抽屉关闭（无 is-open） | `false` | `false` | ✓ PASS |
| 2 | 375 初始：遮罩不存在 | `false` | `false` | ✓ PASS |
| 3 | 375 初始：汉堡按钮存在 | `true` | `true` | ✓ PASS |
| 4 | 375 初始：body 未锁定 | `''` | `""` | ✓ PASS |
| 5 | 375 初始：抽屉移出视口（left < 0） | `left < 0` | `-288` | ✓ PASS |
| 6 | 点击汉堡：抽屉打开（is-open） | `true` | `true` | ✓ PASS |
| 7 | 打开后：遮罩出现 | `true` | `true` | ✓ PASS |
| 8 | 打开后：遮罩为 button（键盘可达） | `button` | `button` | ✓ PASS |
| 9 | 打开后：body 滚动被锁 | `hidden` | `"hidden"` | ✓ PASS |
| 10 | 打开后：抽屉 fully 进屏（left === 0） | `left === 0` | `0` | ✓ PASS |
| 11 | 打开后：aria-expanded 同步 | `true` | `true` | ✓ PASS |
| 12 | Esc 后：抽屉关闭 | `false` | `false` | ✓ PASS |
| 13 | Esc 后：滚动锁释放 | `''` | `""` | ✓ PASS |
| 14 | Esc 后：遮罩移除 | `false` | `false` | ✓ PASS |
| 15 | 二次打开：抽屉打开 | `true` | `true` | ✓ PASS |
| 16 | 点遮罩后：抽屉关闭 | `false` | `false` | ✓ PASS |
| 17 | 点遮罩后：滚动锁释放 | `''` | `""` | ✓ PASS |
| 18 | 路由跳转前：抽屉已打开 | `true` | `true` | ✓ PASS |
| 19 | 路由跳转后：抽屉自动关闭 | `false` | `false (path=/resumes)` | ✓ PASS |
| 20 | 1280：topbar 不显示 | `none` | `none` | ✓ PASS |
| 21 | 1280：抽屉无 is-open | `false` | `false` | ✓ PASS |
| 22 | 1280：侧栏在文档流内（left === 0，非 fixed 移出） | `left === 0` | `0` | ✓ PASS |

**全部通过**：22 项交互检查全部符合预期。