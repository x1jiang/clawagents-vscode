import type { SkillUsageStats } from "../../src/protocol";
import { post } from "./vscodeApi";

export function SkillUsageRanking({ data, enabled }: {
  data: SkillUsageStats | null;
  enabled: boolean;
}) {
  return (
    <div className="skill-usage-ranking">
      <div className="skill-usage-actions">
        <h4 className="skill-subheading">Usage ranking</h4>
        <button className="ghost" onClick={() => post({ type: "load_skill_usage" })}>Refresh</button>
        <button className="ghost" disabled={!data?.skills.length}
          onClick={() => post({ type: "clear_skill_usage" })}>Clear statistics</button>
      </div>
      {!enabled && <p className="muted tiny">Recording is off. Previously recorded statistics remain available.</p>}
      {!data ? <p className="muted tiny">Loading statistics…</p>
        : data.skills.length === 0 ? <p className="muted tiny">No skill loads recorded yet.</p>
        : <>
          <p className="muted tiny">Complete loads only; continuation pages count as one load. Sorted by loads.</p>
          <div className="skill-usage-scroll">
            <table className="skill-usage-table">
              <thead><tr><th scope="col">Skill</th><th scope="col">Loads</th><th scope="col">Chats</th><th scope="col">Last used</th></tr></thead>
              <tbody>{data.skills.map((row) => <tr key={row.name}>
                <th scope="row">{row.name}</th><td>{row.loads}</td><td>{row.chats}</td>
                <td>{new Date(row.last_used * 1000).toLocaleString()}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </>}
    </div>
  );
}
