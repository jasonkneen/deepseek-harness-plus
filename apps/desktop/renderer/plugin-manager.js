const api = window.dshDesktop
const list = document.querySelector('#plugins')
const empty = document.querySelector('#empty')
const status = document.querySelector('#status')
const form = document.querySelector('#install-form')
const input = document.querySelector('#package-spec')
const refresh = document.querySelector('#refresh')

function setBusy(busy, message = '') {
  for (const control of document.querySelectorAll('button, input')) control.disabled = busy
  status.textContent = message
}

async function render() {
  const plugins = await api.plugins.list()
  list.replaceChildren(...plugins.map(plugin => {
    const item = document.createElement('li')
    const identity = document.createElement('span')
    const version = document.createElement('span')
    version.className = 'package-version'
    version.textContent = plugin.version
    identity.append(document.createTextNode(plugin.name), version)
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.textContent = '移除'
    remove.addEventListener('click', () => void run(
      () => api.plugins.remove(plugin.name),
      `正在移除 ${plugin.name}…`,
    ))
    const update = document.createElement('button')
    update.type = 'button'
    update.textContent = '更新'
    update.addEventListener('click', () => {
      const next = window.prompt(`输入 ${plugin.name} 的目标版本`, plugin.version)?.trim()
      if (next === undefined || next === '' || next === plugin.version) return
      void run(() => api.plugins.update(plugin.name, next), `正在更新 ${plugin.name}…`)
    })
    const actions = document.createElement('span')
    actions.className = 'package-actions'
    actions.append(update, remove)
    item.append(identity, actions)
    return item
  }))
  empty.hidden = plugins.length !== 0
}

async function run(operation, message) {
  setBusy(true, message)
  try {
    await operation()
    await render()
    status.textContent = '操作完成，桌面后端已重新启动。'
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error)
  } finally {
    setBusy(false, status.textContent)
  }
}

async function load(message, success) {
  setBusy(true, message)
  try {
    await render()
    status.textContent = success
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error)
  } finally {
    setBusy(false, status.textContent)
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault()
  const spec = input.value.trim()
  if (spec === '') return
  void run(async () => {
    await api.plugins.add(spec)
    input.value = ''
  }, `正在安装 ${spec}…`)
})
refresh.addEventListener('click', () => void load('正在刷新…', '插件列表已刷新。'))

void load('正在读取桌面插件…', '')
