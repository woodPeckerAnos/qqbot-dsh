import { resolve, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const METADATA_EXPORTS = new Set([
  'modules',
  'compositionRoots',
  'stateWrites',
  'stateProvisioners',
  'contractExamples',
]);
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPILER_OPTIONS = {
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  noEmit: true,
  skipLibCheck: false,
  types: ['node'],
};

function declarations(source) {
  if (typeof source !== 'string') return new Map(Object.entries(source));
  const directory = resolve(source);
  return new Map(
    ts.sys
      .readDirectory(directory, ['.d.ts'])
      .map((file) => [relative(directory, file).split(sep).join('/'), ts.sys.readFile(file)])
  );
}

function virtualHost(files, options, roots) {
  const host = ts.createCompilerHost(options);
  const originalRead = host.readFile.bind(host);
  const originalExists = host.fileExists.bind(host);
  const originalDirectory = host.directoryExists.bind(host);
  host.readFile = (file) => files.get(resolve(file)) ?? originalRead(file);
  host.fileExists = (file) => files.has(resolve(file)) || originalExists(file);
  host.directoryExists = (directory) =>
    [...files.keys()].some((file) => file.startsWith(`${resolve(directory)}${sep}`)) ||
    originalDirectory(directory);
  host.getSourceFile = (file, languageVersion) => {
    const text = host.readFile(file);
    return text === undefined ? undefined : ts.createSourceFile(file, text, languageVersion, true);
  };
  host.resolveModuleNames = (names, containingFile) =>
    names.map((name) => {
      if (name === '@qqbot/contracts' || name.startsWith('@qqbot/contracts/')) {
        const root = containingFile.startsWith(roots.baseline) ? roots.baseline : roots.candidate;
        const suffix =
          name === '@qqbot/contracts' ? 'index' : name.slice('@qqbot/contracts/'.length);
        const target = resolve(root, `${suffix}.d.ts`);
        if (files.has(target)) return { resolvedFileName: target, extension: ts.Extension.Dts };
      }
      return ts.resolveModuleName(name, containingFile, options, host).resolvedModule;
    });
  return host;
}

function exportedSymbols(checker, sourceFile) {
  const module = checker.getSymbolAtLocation(sourceFile);
  return new Map(
    module
      ? checker
          .getExportsOfModule(module)
          .filter((symbol) => !METADATA_EXPORTS.has(symbol.name))
          .map((symbol) => [symbol.name, symbol])
      : []
  );
}

function originalSymbol(checker, symbol) {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function typeParameters(symbol) {
  return symbol.declarations?.find((node) => node.typeParameters?.length)?.typeParameters ?? [];
}

function declarationReference(namespace, exportName, parameters) {
  const argumentsText = parameters.length
    ? `<${parameters.map((parameter) => parameter.name.text).join(', ')}>`
    : '';
  return `${namespace}.${exportName}${argumentsText}`;
}

function qualifiedParameters(checker, parameters, namespace, exports) {
  const genericNames = new Set(parameters.map((parameter) => parameter.name.text));
  const printer = ts.createPrinter();
  const transformer = (context) => (root) => {
    const visit = (node) => {
      if (
        ts.isTypeReferenceNode(node) &&
        ts.isIdentifier(node.typeName) &&
        !genericNames.has(node.typeName.text)
      ) {
        const symbol = checker.getSymbolAtLocation(node.typeName);
        const resolved = symbol && originalSymbol(checker, symbol);
        const exported = [...exports.values()].find(
          (entry) => originalSymbol(checker, entry) === resolved
        );
        if (exported)
          return ts.factory.updateTypeReferenceNode(
            node,
            ts.factory.createQualifiedName(ts.factory.createIdentifier(namespace), exported.name),
            node.typeArguments?.map((argument) => ts.visitNode(argument, visit))
          );
      }
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(root, visit);
  };
  const rendered = parameters.map((parameter) => {
    const result = ts.transform(parameter, [transformer]);
    const text = printer.printNode(
      ts.EmitHint.Unspecified,
      result.transformed[0],
      parameter.getSourceFile()
    );
    result.dispose();
    return text;
  });
  return rendered.length ? `<${rendered.join(', ')}>` : '';
}

function checkEnum(checker, oldSymbol, nextSymbol, report) {
  const oldDeclaration = oldSymbol.declarations?.find(ts.isEnumDeclaration);
  if (!oldDeclaration) return;
  const nextDeclaration = nextSymbol.declarations?.find(ts.isEnumDeclaration);
  const oldMembers = new Map(
    oldDeclaration.members.map((member) => [
      member.name.getText(),
      checker.getConstantValue(member),
    ])
  );
  const nextMembers = new Map(
    nextDeclaration?.members.map((member) => [
      member.name.getText(),
      checker.getConstantValue(member),
    ]) ?? []
  );
  if (
    oldMembers.size !== nextMembers.size ||
    [...oldMembers].some(
      ([name, value]) => !nextMembers.has(name) || nextMembers.get(name) !== value
    )
  )
    report('ENUM_CHANGED', '枚举成员和常量值必须保持兼容基线。');
}

function checkDefaults(checker, oldSymbol, nextSymbol, report) {
  const oldParameters = typeParameters(oldSymbol);
  const nextParameters = typeParameters(nextSymbol);
  for (let i = 0; i < oldParameters.length; i++) {
    const oldDefault = oldParameters[i].default;
    const nextDefault = nextParameters[i]?.default;
    if (oldDefault && !nextDefault) report('TYPE_DEFAULT_REMOVED', '不能移除已有类型参数默认值。');
    if (!oldDefault || !nextDefault) continue;
    const oldType = checker.getTypeAtLocation(oldDefault);
    const nextType = checker.getTypeAtLocation(nextDefault);
    if (
      (oldType.flags & ts.TypeFlags.Any) !== (nextType.flags & ts.TypeFlags.Any) ||
      !checker.isTypeAssignableTo(oldType, nextType) ||
      !checker.isTypeAssignableTo(nextType, oldType)
    )
      report('TYPE_DEFAULT_CHANGED', '不能改变已有类型参数默认值。');
  }
}

function typeProbe(checker, oldSymbol, nextSymbol, context) {
  const parameters = typeParameters(oldSymbol);
  const generics = qualifiedParameters(
    checker,
    parameters,
    context.oldNamespace,
    context.oldExports
  );
  const oldReference = declarationReference(context.oldNamespace, context.exportName, parameters);
  const nextReference = declarationReference(context.nextNamespace, context.exportName, parameters);
  const oldType = checker.getDeclaredTypeOfSymbol(oldSymbol);
  const callable = checker.getSignaturesOfType(oldType, ts.SignatureKind.Call).length > 0;
  if (callable)
    return [
      `declare function old${context.id}${generics}(): ${oldReference};`,
      `declare function next${context.id}${generics}(): ${nextReference};`,
      `const compatible${context.id}: typeof old${context.id} = next${context.id};`,
    ];
  const lines = [
    `declare function old${context.id}${generics}(value: ${oldReference}): ${oldReference};`,
    `declare function next${context.id}${generics}(value: ${nextReference}): ${nextReference};`,
    `const compatible${context.id}: typeof old${context.id} = next${context.id};`,
  ];
  for (const property of oldType.getProperties()) {
    if (
      property.name.startsWith('__@') ||
      !property.declarations?.some((node) =>
        node.getSourceFile().fileName.includes('.contract-compatibility/baseline/')
      )
    )
      continue;
    const propertyType = checker.getTypeOfSymbolAtLocation(
      property,
      property.valueDeclaration ?? property.declarations?.[0] ?? oldSymbol.declarations[0]
    );
    if (
      !checker.getSignaturesOfType(checker.getNonNullableType(propertyType), ts.SignatureKind.Call)
        .length
    )
      continue;
    const id = `${context.id}_${lines.length}`;
    const oldMethod = `NonNullable<${oldReference}[${JSON.stringify(property.name)}]>`;
    const nextMethod = `NonNullable<${nextReference}[${JSON.stringify(property.name)}]>`;
    const overloads = checker.getSignaturesOfType(
      checker.getNonNullableType(propertyType),
      ts.SignatureKind.Call
    ).length;
    if (overloads > 1) {
      const signatures = Array.from(
        { length: overloads },
        (_, index) => `(...args: infer A${index}): infer R${index};`
      ).join(' ');
      const entries = Array.from(
        { length: overloads },
        (_, index) => `{ args: A${index}; result: R${index} }`
      ).join(', ');
      lines.push(`type Overloads${id}<T> = T extends { ${signatures} } ? [${entries}] : never;`);
    }
    for (let index = 0; index < overloads; index++) {
      const oldArgs =
        overloads === 1
          ? `Parameters<${oldMethod}>`
          : `Overloads${id}<${oldMethod}>[${index}]['args']`;
      const nextArgs =
        overloads === 1
          ? `Parameters<${nextMethod}>`
          : `Overloads${id}<${nextMethod}>[${index}]['args']`;
      const oldResult =
        overloads === 1
          ? `ReturnType<${oldMethod}>`
          : `Overloads${id}<${oldMethod}>[${index}]['result']`;
      const nextResult =
        overloads === 1
          ? `ReturnType<${nextMethod}>`
          : `Overloads${id}<${nextMethod}>[${index}]['result']`;
      lines.push(
        `declare function oldMethod${id}_${index}${generics}(...args: ${oldArgs}): ${oldResult};`,
        `declare function nextMethod${id}_${index}${generics}(...args: ${nextArgs}): ${nextResult};`,
        `const methodCompatible${id}_${index}: typeof oldMethod${id}_${index} = nextMethod${id}_${index};`,
        `const methodUnchanged${id}_${index}: typeof nextMethod${id}_${index} = oldMethod${id}_${index};`
      );
    }
  }
  // TypeScript assignability permits readonly -> writable. Compare write capabilities separately.
  if (
    oldType.flags & ts.TypeFlags.Object &&
    !checker.isArrayType(oldType) &&
    !checker.isTupleType(oldType)
  )
    lines.push(
      `declare function oldReadonly${context.id}${generics}(): ReadonlyKeys<${oldReference}>;`,
      `declare function nextReadonly${context.id}${generics}(): ReadonlyKeys<Pick<${nextReference}, Extract<keyof ${nextReference}, keyof ${oldReference}>>>;`,
      `const preserveReadonly${context.id}: typeof oldReadonly${context.id} = nextReadonly${context.id};`,
      `const preserveWritable${context.id}: typeof nextReadonly${context.id} = oldReadonly${context.id};`
    );
  return lines;
}

function valueProbe(checker, symbol, context) {
  const type = checker.getTypeOfSymbolAtLocation(
    symbol,
    symbol.valueDeclaration ?? symbol.declarations[0]
  );
  const callable = checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0;
  const oldReference = `typeof ${context.oldNamespace}.${context.exportName}`;
  const nextReference = `typeof ${context.nextNamespace}.${context.exportName}`;
  const lines = [
    `declare const oldValue${context.id}: ${oldReference};`,
    `declare const nextValue${context.id}: ${nextReference};`,
    `const valueCompatible${context.id}: ${oldReference} = nextValue${context.id};`,
  ];
  if (!callable)
    lines.push(`const valueUnchanged${context.id}: ${nextReference} = oldValue${context.id};`);
  return lines;
}

const PROBE_HELPERS = [
  'type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;',
  'type ReadonlyKeys<T> = { [K in keyof T]-?: Equal<Pick<T, K>, { -readonly [P in K]: T[P] }> extends true ? never : K }[keyof T];',
];

/** Compare declarations through consumer assignments in one TypeScript compiler program. */
export function checkCompatibility({ baseline, candidate }) {
  const oldFiles = declarations(baseline);
  const nextFiles = declarations(candidate);
  const roots = {
    baseline: resolve(PROJECT_ROOT, '.contract-compatibility/baseline'),
    candidate: resolve(PROJECT_ROOT, '.contract-compatibility/candidate'),
  };
  const files = new Map();
  for (const [name, text] of oldFiles) files.set(resolve(roots.baseline, name), text);
  for (const [name, text] of nextFiles) files.set(resolve(roots.candidate, name), text);
  const options = { ...COMPILER_OPTIONS };
  const host = virtualHost(files, options, roots);
  const program = ts.createProgram([...files.keys()], options, host);
  const checker = program.getTypeChecker();
  const problems = [];
  const probes = [...PROBE_HELPERS];
  const probeOwners = new Map();
  const report = (code, module, exportName, message) =>
    problems.push({ code, module, exportName, message });
  if (!oldFiles.size) report('BASELINE_MISSING', '', '', '消费者兼容基线缺失。');
  for (const [module] of oldFiles) {
    if (!nextFiles.has(module)) {
      report('REMOVED_MODULE', module, '', '不能移除已发布的模块入口。');
      continue;
    }
    const oldSource = program.getSourceFile(resolve(roots.baseline, module));
    const nextSource = program.getSourceFile(resolve(roots.candidate, module));
    const oldExports = exportedSymbols(checker, oldSource);
    const nextExports = exportedSymbols(checker, nextSource);
    const namespaceId = probes.length;
    const oldNamespace = `Baseline${namespaceId}`;
    const nextNamespace = `Current${namespaceId}`;
    probes.push(
      `import type * as ${oldNamespace} from './baseline/${module.replace(/\.d\.ts$/u, '.js')}';`
    );
    probes.push(
      `import type * as ${nextNamespace} from './candidate/${module.replace(/\.d\.ts$/u, '.js')}';`
    );
    for (const [exportName, exported] of oldExports) {
      const nextExported = nextExports.get(exportName);
      if (!nextExported) {
        report('REMOVED_EXPORT', module, exportName, '不能移除已发布的类型、常量或函数。');
        continue;
      }
      const oldSymbol = originalSymbol(checker, exported);
      const nextSymbol = originalSymbol(checker, nextExported);
      const localReport = (code, message) => report(code, module, exportName, message);
      checkEnum(checker, oldSymbol, nextSymbol, localReport);
      checkDefaults(checker, oldSymbol, nextSymbol, localReport);
      const context = {
        id: probes.length,
        module,
        exportName,
        oldNamespace,
        nextNamespace,
        oldExports,
      };
      const lines = [];
      if (oldSymbol.flags & ts.SymbolFlags.Type) {
        if (!(nextSymbol.flags & ts.SymbolFlags.Type))
          localReport('TYPE_REMOVED', '导出不再提供原有类型。');
        else {
          const oldType = checker.getDeclaredTypeOfSymbol(oldSymbol);
          const nextType = checker.getDeclaredTypeOfSymbol(nextSymbol);
          if ((oldType.flags & ts.TypeFlags.Any) !== (nextType.flags & ts.TypeFlags.Any))
            localReport('TYPE_CHANGED', 'any 不能用于掩盖已发布类型的改变。');
          lines.push(...typeProbe(checker, oldSymbol, nextSymbol, context));
        }
      }
      if (oldSymbol.flags & ts.SymbolFlags.Value) {
        if (!(nextSymbol.flags & ts.SymbolFlags.Value))
          localReport('VALUE_REMOVED', '导出不再提供原有运行时值。');
        else lines.push(...valueProbe(checker, oldSymbol, context));
      }
      for (const line of lines) {
        probeOwners.set(probes.length, { module, exportName });
        probes.push(line);
      }
    }
  }
  const consumer = resolve(PROJECT_ROOT, '.contract-compatibility/consumer.ts');
  files.set(consumer, `${probes.join('\n')}\n`);
  const verification = ts.createProgram(
    [...files.keys()],
    options,
    virtualHost(files, options, roots)
  );
  for (const diagnostic of ts.getPreEmitDiagnostics(verification)) {
    if (diagnostic.file?.fileName === consumer) {
      const line = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line;
      const owner = probeOwners.get(line) ?? { module: '', exportName: '' };
      report(
        'INCOMPATIBLE_SIGNATURE',
        owner.module,
        owner.exportName,
        ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
      );
    } else if (
      diagnostic.file?.fileName.startsWith(roots.baseline) ||
      diagnostic.file?.fileName.startsWith(roots.candidate)
    ) {
      report(
        'INVALID_DECLARATION',
        relative(PROJECT_ROOT, diagnostic.file.fileName),
        '',
        ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
      );
    } else {
      report(
        'COMPILATION_FAILED',
        diagnostic.file?.fileName ?? '',
        '',
        ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
      );
    }
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = checkCompatibility({
    baseline: resolve(PROJECT_ROOT, 'packages/contracts/compatibility/v1'),
    candidate: resolve(PROJECT_ROOT, 'packages/contracts/dist'),
  });
  for (const problem of problems)
    console.error(`${problem.code} ${problem.module} ${problem.exportName}: ${problem.message}`);
  if (problems.length) process.exitCode = 1;
  else console.log('Contract consumer compatibility: passed');
}
