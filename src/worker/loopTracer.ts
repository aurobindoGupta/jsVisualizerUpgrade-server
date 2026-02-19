import type { PluginObj } from '@babel/core';
import * as t from '@babel/types';
import type { NodePath } from '@babel/traverse';

type LoopNode =
  | t.WhileStatement
  | t.DoWhileStatement
  | t.ForStatement
  | t.ForInStatement
  | t.ForOfStatement;

const ensureBlockBody = (path: NodePath<LoopNode>): void => {
  const body = path.node.body;
  if (!t.isBlockStatement(body)) {
    path.node.body = t.blockStatement([body as t.Statement]);
  }
};

const addIterateLoop = (path: NodePath<LoopNode>): void => {
  ensureBlockBody(path);
  const call = t.expressionStatement(
    t.callExpression(
      t.memberExpression(t.identifier('Tracer'), t.identifier('iterateLoop')),
      [],
    ),
  );
  (path.get('body') as NodePath<t.BlockStatement>).pushContainer('body', call);
};

export const traceLoops = (): PluginObj => ({
  visitor: {
    WhileStatement: (path) => addIterateLoop(path as NodePath<t.WhileStatement>),
    DoWhileStatement: (path) => addIterateLoop(path as NodePath<t.DoWhileStatement>),
    ForStatement: (path) => addIterateLoop(path as NodePath<t.ForStatement>),
    ForInStatement: (path) => addIterateLoop(path as NodePath<t.ForInStatement>),
    ForOfStatement: (path) => addIterateLoop(path as NodePath<t.ForOfStatement>),
  },
});
