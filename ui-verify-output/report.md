# JobPilot UI 第一阶段 · 响应式与布局实测

基准地址：http://localhost:3000
登录态：已登录（register: uiverify+1789911216987@example.com）
检查项：14 页面 × 7 视口 = 98 次实测

## 1. 横向溢出检查

**全部通过**：14 页面 × 7 视口均无横向滚动（`scrollWidth - clientWidth ≤ 1`）。

## 2. 侧栏形态（桌面静态 / 移动抽屉）

| 视口 | 采样页面 | position | width | left | transform | topbar |
|---|---|---|---|---|---|---|
| 320 | login | fixed | 269 | -269 | set | flex |
| 375 | login | fixed | 288 | -288 | set | flex |
| 640 | login | fixed | 288 | -288 | set | flex |
| 768 | login | fixed | 288 | -288 | set | flex |
| 1024 | login | sticky | 212 | 0 | none | none |
| 1280 | login | sticky | 244 | 0 | none | none |
| 1536 | login | sticky | 244 | 0 | none | none |

## 3. 标题层级与正文

| 视口 | 采样页面 | h1 字号 | h1 字重 | body 字号 | 比值 |
|---|---|---|---|---|---|
| 320 | jds | 22px | 700 | 14px | 1.57× |
| 375 | jds | 22px | 700 | 14px | 1.57× |
| 640 | jds | 22px | 700 | 14px | 1.57× |
| 768 | jds | 28px | 700 | 14px | 2.00× |
| 1024 | jds | 28px | 700 | 14px | 2.00× |
| 1280 | jds | 28px | 700 | 14px | 2.00× |
| 1536 | jds | 28px | 700 | 14px | 2.00× |

## 4. 主内容宽度（大屏不无限拉伸）

| 视口 | 采样页面 | app-main 宽 | content-wrap 宽 |
|---|---|---|---|
| 320 | login | 320 | 304 |
| 375 | login | 375 | 351 |
| 640 | login | 640 | 616 |
| 768 | login | 768 | 736 |
| 1024 | login | 812 | 764 |
| 1280 | login | 1036 | 956 |
| 1536 | login | 1292 | 1180 |

## 5. 触控目标（< 30px 高视为偏小）

**全部通过**：未发现高度 < 30px 的可见按钮。

## 6. 组件计算样式抽样

### 320px（采样页面：jds）

- `.card` border-radius: 8px
- `.btn-primary`: 90×40, radius=8px, font=14px
- `input/textarea/select`: 278×160, radius=8px

### 1280px（采样页面：jds）

- `.card` border-radius: 10px
- `.btn-primary`: 90×40, radius=8px, font=14px
- `input/textarea/select`: 914×160, radius=8px

## 7. 探针错误

**无**：98 次实测全部成功返回探针数据。
