import { builtinModules } from 'node:module';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/u, '')));
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];
const RECORD_DOMAINS = {
  TaskSnapshot: 'tasks',
  QueuedMessage: 'messages',
  BudgetRecord: 'task-budgets',
  SessionContextState: 'task-sessions',
};

function canonical(file) {
  const absolute = resolve(file);
  return ts.sys.realpath?.(absolute) ?? absolute;
}

function portable(file) {
  return file.split(sep).join('/');
}

function inside(file, directory) {
  const path = relative(directory, file);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function sourceFiles(directory) {
  return ts.sys.readDirectory(directory, EXTENSIONS, ['**/node_modules/**', '**/dist/**']);
}

function aliasTarget(checker, symbol) {
  return symbol?.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function symbolDeclarations(symbol) {
  return symbol?.getDeclarations() ?? [];
}

function isClassSymbol(symbol, productionDirectory) {
  return symbolDeclarations(symbol).some(
    (declaration) =>
      (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) &&
      inside(canonical(declaration.getSourceFile().fileName), productionDirectory)
  );
}

function isProductionContractType(symbol, productionDirectory) {
  return symbolDeclarations(symbol).some(
    (declaration) =>
      (ts.isInterfaceDeclaration(declaration) ||
        ts.isTypeAliasDeclaration(declaration) ||
        ts.isEnumDeclaration(declaration)) &&
      inside(canonical(declaration.getSourceFile().fileName), productionDirectory)
  );
}

function isContractError(checker, node) {
  const visited = new Set();
  const derivesFromError = (type) => {
    if (visited.has(type)) return false;
    visited.add(type);
    const symbol = type.getSymbol();
    if (
      symbol?.name === 'Error' &&
      symbolDeclarations(symbol).every(
        (declaration) => declaration.getSourceFile().isDeclarationFile
      )
    )
      return true;
    if (!(type.objectFlags & ts.ObjectFlags.ClassOrInterface)) return false;
    return (type.getBaseTypes() ?? []).some(derivesFromError);
  };
  return derivesFromError(checker.getTypeAtLocation(node));
}

function referencesImplementation(
  checker,
  type,
  productionDirectory,
  visited = new Set(),
  namedTypes = false
) {
  if (!type || visited.has(type)) return false;
  visited.add(type);
  const symbol = type.aliasSymbol ?? type.getSymbol();
  if (isClassSymbol(symbol, productionDirectory)) return true;
  if (namedTypes && isProductionContractType(symbol, productionDirectory)) return true;
  const parts = type.isUnionOrIntersection() ? [...type.types] : [];
  const parameters = [...(type.aliasTypeArguments ?? [])];
  if (type.objectFlags & ts.ObjectFlags.Reference)
    parameters.push(...checker.getTypeArguments(type));
  if (
    [...parts, ...parameters].some((part) =>
      referencesImplementation(checker, part, productionDirectory, visited, namedTypes)
    )
  )
    return true;
  const declarations = symbolDeclarations(symbol);
  if (
    declarations.length &&
    declarations.every((declaration) =>
      declaration.getSourceFile().fileName.includes(`${sep}node_modules${sep}`)
    )
  )
    return false;
  const signatures = [...type.getCallSignatures(), ...type.getConstructSignatures()];
  for (const signature of signatures) {
    if (
      referencesImplementation(
        checker,
        signature.getReturnType(),
        productionDirectory,
        visited,
        namedTypes
      )
    )
      return true;
    for (const parameter of signature.getParameters()) {
      const at = parameter.valueDeclaration ?? parameter.declarations?.[0];
      if (
        at &&
        referencesImplementation(
          checker,
          checker.getTypeOfSymbolAtLocation(parameter, at),
          productionDirectory,
          visited,
          namedTypes
        )
      )
        return true;
    }
  }
  for (const property of type.getProperties()) {
    const at = property.valueDeclaration ?? property.declarations?.[0];
    if (
      at &&
      referencesImplementation(
        checker,
        checker.getTypeOfSymbolAtLocation(property, at),
        productionDirectory,
        visited,
        namedTypes
      )
    )
      return true;
  }
  return false;
}

function isTypeOnlyImport(node) {
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  return (
    !clause.name &&
    clause.namedBindings &&
    ts.isNamedImports(clause.namedBindings) &&
    clause.namedBindings.elements.length > 0 &&
    clause.namedBindings.elements.every((element) => element.isTypeOnly)
  );
}

function isTypeOnlyExport(node) {
  if (node.isTypeOnly) return true;
  return (
    node.exportClause &&
    ts.isNamedExports(node.exportClause) &&
    node.exportClause.elements.length > 0 &&
    node.exportClause.elements.every((element) => element.isTypeOnly)
  );
}

function memberName(expression) {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    ts.isStringLiteralLike(expression.argumentExpression)
  )
    return expression.argumentExpression.text;
  return undefined;
}

function originExpression(checker, expression, visited = new Set()) {
  if (!ts.isIdentifier(expression) || visited.has(expression.text)) return expression;
  visited.add(expression.text);
  const symbol = aliasTarget(checker, checker.getSymbolAtLocation(expression));
  const declaration = symbolDeclarations(symbol).find(ts.isVariableDeclaration);
  if (declaration?.initializer) return originExpression(checker, declaration.initializer, visited);
  return expression;
}

function requireCall(checker, node) {
  if (!ts.isCallExpression(node)) return false;
  const expression = originExpression(checker, node.expression);
  const symbol = aliasTarget(checker, checker.getSymbolAtLocation(expression));
  const external = symbolDeclarations(symbol).every(
    (declaration) => declaration.getSourceFile().isDeclarationFile
  );
  if (ts.isIdentifier(expression) && expression.text === 'require' && external) return true;
  if (memberName(expression) === 'require' && external) return true;
  const type = checker.getTypeAtLocation(expression);
  return ['Require', 'NodeRequire'].includes(type.getSymbol()?.name);
}

function importsAt(checker, node) {
  if (ts.isImportDeclaration(node))
    return { target: node.moduleSpecifier, typeOnly: isTypeOnlyImport(node) };
  if (ts.isExportDeclaration(node) && node.moduleSpecifier)
    return { target: node.moduleSpecifier, typeOnly: isTypeOnlyExport(node) };
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference) &&
    node.moduleReference.expression
  )
    return { target: node.moduleReference.expression, typeOnly: node.isTypeOnly };
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
    return { target: node.argument.literal, typeOnly: true };
  if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword || requireCall(checker, node))
  )
    return { target: node.arguments[0], typeOnly: false };
  return undefined;
}

function packageName(specifier) {
  return specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];
}

function externalCapability(specifier) {
  const bare = specifier.replace(/^node:/u, '');
  return BUILTINS.has(bare) ? `node:${bare}` : packageName(specifier);
}

function inTypePosition(node) {
  let parent = node.parent;
  while (parent) {
    if (ts.isTypeNode(parent)) return true;
    if (ts.isStatement(parent) || ts.isExpression(parent)) break;
    parent = parent.parent;
  }
  return false;
}

function globalCapability(checker, node) {
  if (inTypePosition(node)) return undefined;
  const expression = node;
  if (
    (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'globalThis'
  )
    return ['fetch', 'WebSocket'].includes(memberName(expression))
      ? memberName(expression)
      : undefined;
  if (!ts.isIdentifier(expression) || !['fetch', 'WebSocket'].includes(expression.text))
    return undefined;
  if (ts.isPropertyAccessExpression(expression.parent) && expression.parent.name === expression)
    return undefined;
  if (expression.parent.name === expression && !ts.isShorthandPropertyAssignment(expression.parent))
    return undefined;
  const symbol = aliasTarget(checker, checker.getSymbolAtLocation(expression));
  return symbolDeclarations(symbol).every(
    (declaration) => declaration.getSourceFile().isDeclarationFile
  )
    ? expression.text
    : undefined;
}

function contractTypes(checker, type, contractsDirectory, visited = new Set()) {
  if (!type || visited.has(type)) return [];
  visited.add(type);
  const symbols = [type.aliasSymbol, type.getSymbol()].filter(Boolean);
  const names = symbols
    .filter((symbol) =>
      symbolDeclarations(symbol).some((declaration) =>
        inside(canonical(declaration.getSourceFile().fileName), contractsDirectory)
      )
    )
    .map((symbol) => symbol.name);
  const parts = type.isUnionOrIntersection() ? [...type.types] : [];
  if (type.objectFlags & ts.ObjectFlags.ClassOrInterface)
    parts.push(...(type.getBaseTypes() ?? []));
  return [
    ...names,
    ...parts.flatMap((part) => contractTypes(checker, part, contractsDirectory, visited)),
  ];
}

function receiverAt(checker, call) {
  const expression = originExpression(checker, call.expression);
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression))
    return { expression: expression.expression, method: memberName(expression) };
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = checker.getSymbolAtLocation(expression);
  const binding = symbolDeclarations(symbol).find(ts.isBindingElement);
  const declaration = binding?.parent?.parent;
  if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer)
    return {
      expression: declaration.initializer,
      method:
        binding.propertyName && ts.isStringLiteralLike(binding.propertyName)
          ? binding.propertyName.text
          : (binding.propertyName?.getText() ?? binding.name.getText()),
    };
  return undefined;
}

function stateDomain(checker, type) {
  const property = type.getProperty('domain');
  const at = property?.valueDeclaration ?? property?.declarations?.[0];
  if (at) {
    const domain = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(property, at));
    if (domain.isStringLiteral()) return domain.value;
  }
  const parameters = [...(type.aliasTypeArguments ?? [])];
  if (type.objectFlags & ts.ObjectFlags.Reference)
    parameters.push(...checker.getTypeArguments(type));
  for (const parameter of parameters) {
    const name = parameter.aliasSymbol?.name ?? parameter.getSymbol()?.name;
    if (name in RECORD_DOMAINS) return RECORD_DOMAINS[name];
  }
  return undefined;
}

function provisionReference(context, node) {
  const { checker, owners, contractsDirectory } = context;
  if (inTypePosition(node)) return false;
  if (
    ts.isIdentifier(node) &&
    ts.isPropertyAccessExpression(node.parent) &&
    node.parent.name === node
  )
    return false;
  const expression = ts.isCallExpression(node) ? originExpression(checker, node.expression) : node;
  if (!ts.isIdentifier(expression) && !ts.isPropertyAccessExpression(expression)) return false;
  if (ts.isIdentifier(expression) && ts.isImportSpecifier(expression.parent)) {
    const declaration = expression.parent.parent.parent.parent;
    if (ts.isImportDeclaration(declaration) && isTypeOnlyImport(declaration)) return false;
  }
  const symbol = aliasTarget(checker, checker.getSymbolAtLocation(expression));
  return (
    symbol?.name === 'createStateWriter' &&
    symbolDeclarations(symbol).some((declaration) => {
      const file = canonical(declaration.getSourceFile().fileName);
      return inside(file, contractsDirectory) || owners.get(file)?.id === 'store';
    })
  );
}

function writeReceiver(checker, node) {
  if (inTypePosition(node)) return undefined;
  if (ts.isCallExpression(node)) return receiverAt(checker, node);
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    if (ts.isCallExpression(node.parent) && node.parent.expression === node) return undefined;
    return { expression: node.expression, method: memberName(node) };
  }
  if (!ts.isBindingElement(node)) return undefined;
  const declaration = node.parent.parent;
  if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) return undefined;
  return {
    expression: declaration.initializer,
    method:
      node.propertyName && ts.isStringLiteralLike(node.propertyName)
        ? node.propertyName.text
        : (node.propertyName?.getText() ?? node.name.getText()),
  };
}

function checkStateWrite(context, source, node, module) {
  const { checker, contractsDirectory, stateWrites, stateProvisioners, report, root } = context;
  const file = portable(relative(root, canonical(source.fileName)));
  if (
    provisionReference(context, node) &&
    module.id !== 'store' &&
    !stateProvisioners.includes(file)
  )
    report(
      'STATE_PROVISION_DENIED',
      source,
      node,
      `仅 ${stateProvisioners.join(', ')} 可发放状态写入能力`
    );
  const receiver = writeReceiver(checker, node);
  if (!receiver) return;
  const type = checker.getNonNullableType(checker.getTypeAtLocation(receiver.expression));
  const names = contractTypes(checker, type, contractsDirectory);
  const matching = stateWrites.filter(
    (rule) => names.includes(rule.type) && rule.methods.includes(receiver.method)
  );
  const domain = stateDomain(checker, type);
  if (!matching.length && names.some((name) => ['StateWriter', 'TaskStore'].includes(name))) {
    if (receiver.method !== 'save' || module.id === 'store') return;
    matching.push(...stateWrites.filter((rule) => domain && rule.domain === domain));
    if (!matching.length) {
      report('STATE_WRITE_DENIED', source, node, '通用持久化写入缺少可核验的状态域和所有者');
      return;
    }
  }
  for (const rule of matching) {
    if (!rule.owners.includes(file))
      report(
        'STATE_WRITE_DENIED',
        source,
        node,
        `${rule.domain ?? rule.type} 仅允许 ${rule.owners.join(', ')} 写入`
      );
    if (domain && rule.domain && domain !== rule.domain)
      report('STATE_DOMAIN_MISMATCH', source, node, `${rule.type} 不能写入 ${domain}`);
  }
}

function checkPublicEntry(context, source) {
  const { checker, productionDirectory, report } = context;
  const symbol = checker.getSymbolAtLocation(source);
  if (!symbol) return;
  for (const exported of checker.getExportsOfModule(symbol)) {
    const target = aliasTarget(checker, exported);
    const declaration = target.valueDeclaration ?? target.declarations?.[0];
    if (!declaration) continue;
    const type =
      target.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)
        ? checker.getDeclaredTypeOfSymbol(target)
        : checker.getTypeOfSymbolAtLocation(target, declaration);
    if (
      isClassSymbol(target, productionDirectory) ||
      referencesImplementation(checker, type, productionDirectory)
    )
      report(
        'IMPLEMENTATION_EXPORT',
        source,
        source,
        `公共入口 ${exported.name} 泄漏生产实现类；使用契约接口和显式工厂签名`
      );
    else if (
      isProductionContractType(target, productionDirectory) ||
      referencesImplementation(checker, type, productionDirectory, new Set(), true)
    )
      report(
        'CONTRACT_TYPE_SOURCE',
        source,
        source,
        `公共入口 ${exported.name} 使用生产局部命名类型；跨模块类型必须来自独立契约包`
      );
  }
}

function addRuntimeEdge(graph, from, to, typeOnly) {
  if (!typeOnly && from !== to) graph.get(from)?.add(to);
}

function checkImport(context, source, node, imported, module) {
  const { root, owners, compilerOptions, productionDirectory, contractsDirectory, report, graph } =
    context;
  const target = imported.target;
  if (!target || !ts.isStringLiteralLike(target)) {
    report('DYNAMIC_TARGET_UNKNOWN', source, node, 'require 和动态导入必须提供可解析的字面量目标');
    return;
  }
  const specifier = target.text;
  const inContracts = inside(canonical(source.fileName), contractsDirectory);
  const isContractPackage =
    specifier === '@qqbot/contracts' || specifier.startsWith('@qqbot/contracts/');
  if (isContractPackage && !inContracts) return;
  const resolution = ts.resolveModuleName(
    specifier,
    source.fileName,
    compilerOptions,
    ts.sys
  ).resolvedModule;
  const resolved = resolution && canonical(resolution.resolvedFileName);
  if (inContracts) {
    if (resolved && inside(resolved, productionDirectory))
      report('CONTRACT_IMPLEMENTATION_DEPENDENCY', source, node, '契约包不能依赖生产实现');
    else if (!imported.typeOnly && (!resolved || !inside(resolved, contractsDirectory)))
      report('CONTRACT_RUNTIME_DEPENDENCY', source, node, '契约运行时只允许独立契约源码依赖');
    return;
  }
  if (!module) return;
  if (resolved && inside(resolved, productionDirectory)) {
    const owner = owners.get(resolved);
    if (!owner) {
      report(
        'UNOWNED_IMPORT',
        source,
        node,
        `${portable(relative(root, resolved))} 尚未声明所属模块`
      );
      return;
    }
    if (owner.id === module.id) return;
    if (owner.composition)
      report('COMPOSITION_IMPORT_DENIED', source, node, '生产装配入口不能被业务模块消费');
    if (resolved !== canonical(resolve(root, owner.entry)))
      report(
        'DEEP_IMPORT',
        source,
        node,
        `${module.id} 跨模块引用 ${owner.id} 内部路径；只允许 ${owner.entry}`
      );
    if (!module.dependencies.includes(owner.id))
      report('UNDECLARED_DEPENDENCY', source, node, `${module.id} 未声明依赖 ${owner.id}`);
    addRuntimeEdge(graph, module.id, owner.id, imported.typeOnly);
    return;
  }
  if (resolved && inside(resolved, contractsDirectory)) return;
  if (specifier.startsWith('.') || isAbsolute(specifier)) {
    report(
      'UNRESOLVED_PROJECT_IMPORT',
      source,
      node,
      `无法解析到已声明模块或契约的目标 ${specifier}`
    );
    return;
  }
  if (!imported.typeOnly && !module.capabilities.includes(externalCapability(specifier)))
    report(
      'CAPABILITY_DENIED',
      source,
      node,
      `${module.id} 未声明外部能力 ${externalCapability(specifier)}`
    );
  if (!resolution && !BUILTINS.has(specifier.replace(/^node:/u, '')))
    report('UNRESOLVED_EXTERNAL_IMPORT', source, node, `未解析外部模块 ${specifier}`);
}

function checkSource(context, source) {
  const { owners, contractsDirectory, checker, report } = context;
  const file = canonical(source.fileName);
  const module = owners.get(file);
  const inContracts = inside(file, contractsDirectory);
  if (!module && !inContracts) return;
  const visit = (node) => {
    const imported = importsAt(checker, node);
    if (imported) checkImport(context, source, node, imported, module);
    if (
      inContracts &&
      (ts.isClassDeclaration(node) || ts.isClassExpression(node)) &&
      !isContractError(checker, node)
    )
      report('CONTRACT_IMPLEMENTATION_CLASS', source, node, '契约包只声明接口，不包含实现类');
    if (module) {
      const capability = globalCapability(checker, node);
      if (capability && !module.capabilities.includes(capability))
        report('CAPABILITY_DENIED', source, node, `${module.id} 未声明全局能力 ${capability}`);
      checkStateWrite(context, source, node, module);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (module && !module.composition && file === canonical(resolve(context.root, module.entry)))
    checkPublicEntry(context, source);
}

function checkCycles(graph, report) {
  const completed = new Set();
  const stack = [];
  const active = new Set();
  const visit = (module) => {
    if (active.has(module)) {
      report(
        'RUNTIME_DEPENDENCY_CYCLE',
        undefined,
        undefined,
        [...stack.slice(stack.indexOf(module)), module].join(' → ')
      );
      return;
    }
    if (completed.has(module)) return;
    active.add(module);
    stack.push(module);
    for (const dependency of [...(graph.get(module) ?? [])].sort()) visit(dependency);
    stack.pop();
    active.delete(module);
    completed.add(module);
  };
  for (const module of [...graph.keys()].sort()) visit(module);
}

/** 独立于 ESLint 存量基线；测试可传入临时仓库与合成模块元数据。 */
export function checkBoundaries({
  root = process.cwd(),
  modules,
  productionRoot = 'src',
  contractsRoot = 'packages/contracts',
  compilerOptions = {},
  stateWrites = [],
  stateProvisioners = ['src/task/system.ts'],
  compositionRoots = [],
}) {
  root = canonical(root);
  const diagnostics = [];
  const report = (code, source, node, message) => {
    const position =
      source && node ? source.getLineAndCharacterOfPosition(node.getStart(source)) : undefined;
    diagnostics.push({
      code,
      file: source ? portable(relative(root, canonical(source.fileName))) : '',
      line: position ? position.line + 1 : 0,
      message,
    });
  };
  const owners = new Map();
  const identifiers = new Set();
  for (const module of modules) {
    if (identifiers.has(module.id)) report('DUPLICATE_MODULE', undefined, undefined, module.id);
    identifiers.add(module.id);
    if (!module.files.includes(module.entry))
      report('UNOWNED_ENTRY', undefined, undefined, module.entry);
    for (const file of module.files) {
      const absolute = canonical(resolve(root, file));
      if (owners.has(absolute)) report('DUPLICATE_FILE_OWNER', undefined, undefined, file);
      if (!ts.sys.fileExists(absolute)) report('MISSING_MODULE_FILE', undefined, undefined, file);
      owners.set(absolute, module);
    }
  }
  for (const module of modules)
    for (const dependency of module.dependencies)
      if (!identifiers.has(dependency))
        report('UNKNOWN_DEPENDENCY', undefined, undefined, `${module.id} → ${dependency}`);
  const composition = compositionRoots
    .filter((file) => ts.sys.fileExists(resolve(root, file)))
    .map((file) => ({
      id: `<composition:${file}>`,
      entry: file,
      files: [file],
      dependencies: modules.map((module) => module.id),
      capabilities: ['node:path'],
      composition: true,
    }));
  for (const module of composition) {
    const absolute = canonical(resolve(root, module.entry));
    if (owners.has(absolute)) report('DUPLICATE_FILE_OWNER', undefined, undefined, module.entry);
    owners.set(absolute, module);
  }
  const productionDirectory = canonical(resolve(root, productionRoot));
  const contractsDirectory = canonical(resolve(root, contractsRoot));
  const production = sourceFiles(productionDirectory);
  for (const file of production)
    if (!owners.has(canonical(file)))
      report('UNCOVERED_PRODUCTION_FILE', undefined, undefined, portable(relative(root, file)));
  const options = {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowJs: true,
    strict: true,
    skipLibCheck: true,
    ...compilerOptions,
  };
  const program = ts.createProgram(
    [...production, ...sourceFiles(resolve(contractsDirectory, 'src'))],
    options
  );
  const graph = new Map([...modules, ...composition].map((module) => [module.id, new Set()]));
  const context = {
    root,
    owners,
    checker: program.getTypeChecker(),
    compilerOptions: options,
    productionDirectory,
    contractsDirectory,
    report,
    graph,
    stateWrites,
    stateProvisioners,
  };
  for (const source of program.getSourceFiles()) checkSource(context, source);
  checkCycles(graph, report);
  return diagnostics.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.code.localeCompare(b.code) ||
      a.message.localeCompare(b.message)
  );
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const metadata = await import('../packages/contracts/dist/metadata.js');
  const config = ts.readConfigFile(resolve(root, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const diagnostics = checkBoundaries({
    root,
    modules: metadata.modules,
    compilerOptions: parsed.options,
    stateWrites: metadata.stateWrites,
    stateProvisioners: metadata.stateProvisioners,
    compositionRoots: metadata.compositionRoots,
  });
  for (const diagnostic of diagnostics)
    console.error(
      `${diagnostic.file || '<modules>'}:${diagnostic.line} [${diagnostic.code}] ${diagnostic.message}`
    );
  if (diagnostics.length) process.exitCode = 1;
  else
    console.log(
      `模块边界通过：${metadata.modules.length} 个模块，生产路径、公共接口、能力与写入所有权已检查。`
    );
}

if (process.argv[1] && canonical(process.argv[1]) === canonical(fileURLToPath(import.meta.url)))
  await main();
