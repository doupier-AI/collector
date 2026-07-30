import { Link } from "react-router-dom";

export function NotFoundPage() {
  return (
    <div className="page">
      <h1 className="page__title">没有找到这个页面</h1>
      <p className="page__lead">链接可能已经过期或输入有误。</p>
      <p>
        <Link className="button button--primary" to="/">
          返回开始页
        </Link>
      </p>
    </div>
  );
}
